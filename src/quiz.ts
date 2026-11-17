import { MoodleClient, MoodleError, NotLoggedInError } from "./moodle.js";
import { formatDate, formatDateRelative, formatDuration, htmlToText, questionHtmlToText, summarize, truncate } from "./format.js";
import { getScopeCourses, mapLimit, nowSeconds } from "./tools.js";

interface Quiz {
  id: number;
  coursemodule: number;
  course: number;
  name: string;
  intro?: string;
  timeopen?: number;
  timeclose?: number;
  timelimit?: number;
  /** Attempts allowed; 0 means unlimited. */
  attempts?: number;
  sumgrades?: number | null;
  grade?: number;
}

interface Attempt {
  id: number;
  quiz?: number;
  attempt?: number;
  state?: string;
  timestart?: number;
  timefinish?: number;
  sumgrades?: number | null;
}

const number = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** Attempt marks are on the quiz's internal scale; the grade students see is rescaled. */
function attemptGrade(attempt: Attempt, quiz: Quiz): string {
  if (attempt.sumgrades === null || attempt.sumgrades === undefined || !quiz.sumgrades || !quiz.grade) return "";
  return `${number((attempt.sumgrades / quiz.sumgrades) * quiz.grade)} / ${number(quiz.grade)}`;
}

function describeAttempt(attempt: Attempt, quiz: Quiz): string {
  const label = `[attempt ${attempt.id}] #${attempt.attempt ?? "?"}`;
  if (attempt.state === "finished") {
    const grade = attemptGrade(attempt, quiz);
    return `${label} finished ${formatDate(attempt.timefinish)}${grade ? `, grade ${grade}` : ", grade not shown"}`;
  }
  if (attempt.state === "inprogress" || attempt.state === "overdue") {
    return `${label} in progress since ${formatDate(attempt.timestart)} (questions cannot be read here until it is finished)`;
  }
  return `${label} ${attempt.state ?? "unknown state"}`;
}

const MAX_QUIZZES = 40;

export async function listQuizzes(client: MoodleClient, args: { course_id?: number }): Promise<string> {
  const scope = await getScopeCourses(client, args.course_id);
  const names = new Map(scope.map((course) => [course.id, course.fullname]));
  const data = await client.call<{ quizzes: Quiz[] }>("mod_quiz_get_quizzes_by_courses", { courseids: scope.map((c) => c.id) });
  const quizzes = (data.quizzes ?? []).slice().sort((a, b) => (a.timeclose || Infinity) - (b.timeclose || Infinity));
  if (!quizzes.length) return "No quizzes found in these courses.";
  const now = nowSeconds();
  const shown = quizzes.slice(0, MAX_QUIZZES);
  const details = await mapLimit(shown, 5, async (quiz) => {
    try {
      const [attempts, best] = await Promise.all([
        client.call<{ attempts: Attempt[] }>("mod_quiz_get_user_attempts", { quizid: quiz.id, status: "all" }),
        client.call<{ hasgrade?: boolean; grade?: number }>("mod_quiz_get_user_best_grade", { quizid: quiz.id }),
      ]);
      return { attempts: attempts.attempts ?? [], best };
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err;
      return undefined;
    }
  });
  const lines = shown.map((quiz, index) => {
    const out = [`- [quiz ${quiz.id}, cmid ${quiz.coursemodule}] ${htmlToText(quiz.name)} — ${names.get(quiz.course) ?? `Course ${quiz.course}`} [course ${quiz.course}]`];
    const facts = [
      quiz.timeopen ? `${quiz.timeopen > now ? "opens" : "opened"}: ${formatDate(quiz.timeopen)}` : "",
      `closes: ${formatDateRelative(quiz.timeclose, now)}`,
      quiz.timelimit ? `time limit: ${formatDuration(quiz.timelimit)}` : "",
      `attempts allowed: ${quiz.attempts ? quiz.attempts : "unlimited"}`,
    ].filter(Boolean);
    out.push(`  ${facts.join(" | ")}`);
    const detail = details[index];
    if (!detail) {
      out.push("  attempts: unavailable");
    } else if (!detail.attempts.length) {
      out.push("  attempts: none yet");
    } else {
      if (detail.best.hasgrade && typeof detail.best.grade === "number") {
        out.push(`  best grade: ${number(detail.best.grade)}${quiz.grade ? ` / ${number(quiz.grade)}` : ""}`);
      }
      for (const attempt of detail.attempts) out.push(`  attempt: ${describeAttempt(attempt, quiz)}`);
    }
    const intro = summarize(quiz.intro, 200);
    if (intro) out.push(`  ${intro}`);
    return out.join("\n");
  });
  const more = quizzes.length > shown.length ? `\n\n(${quizzes.length - shown.length} more not shown; narrow down with course_id.)` : "";
  return `${quizzes.length} quizzes, soonest closing first. Review a finished attempt with get_quiz_attempt.\n${lines.join("\n")}${more}`;
}

interface ReviewQuestion {
  slot: number;
  type?: string;
  html?: string;
  /** Question number as printed; missing for descriptions. */
  questionnumber?: string;
  number?: number;
  status?: string;
  mark?: string | number;
  maxmark?: number;
}

interface Review {
  grade?: string | number;
  attempt?: Attempt;
  additionaldata?: { id: string; title: string; content: string }[];
  questions?: ReviewQuestion[];
}

const MAX_QUESTION_CHARS = 3000;

export async function getQuizAttempt(client: MoodleClient, args: { attempt_id: number }): Promise<string> {
  let review: Review;
  try {
    // Moodle only answers this for attempts the student may review: it refuses
    // open attempts and quizzes whose teacher has not released the review.
    review = await client.call<Review>("mod_quiz_get_attempt_review", { attemptid: args.attempt_id, page: -1 });
  } catch (err) {
    if (err instanceof MoodleError && err.errorcode === "noreview") {
      throw new MoodleError(
        `Attempt ${args.attempt_id} cannot be reviewed: the teacher has not made the review of this quiz available (or not yet). Nothing else can be read from it.`,
        err.errorcode,
      );
    }
    if (err instanceof MoodleError && err.errorcode === "attemptclosed") {
      throw new MoodleError(`Attempt ${args.attempt_id} is not finished. Only finished attempts can be read.`, err.errorcode);
    }
    throw err;
  }
  // Never show the questions of an attempt that can still be answered.
  if (review.attempt?.state !== "finished") {
    throw new MoodleError(`Attempt ${args.attempt_id} is not finished (state: ${review.attempt?.state ?? "unknown"}). Only finished attempts can be read.`, "attemptnotfinished");
  }
  const header = [`Review of attempt ${args.attempt_id} (quiz ${review.attempt.quiz ?? "?"}), finished ${formatDate(review.attempt.timefinish)}.`];
  if (review.grade !== undefined && review.grade !== "") {
    header.push(`Grade: ${typeof review.grade === "number" ? number(review.grade) : htmlToText(review.grade)}`);
  }
  for (const extra of review.additionaldata ?? []) {
    const content = htmlToText(extra.content);
    if (content) header.push(`${htmlToText(extra.title)}: ${content}`);
  }
  const questions = review.questions ?? [];
  if (!questions.length) return `${header.join("\n")}\n\nNo questions are visible in this review.`;
  const blocks = questions.map((question) => {
    const label = question.questionnumber ?? (question.number ? String(question.number) : "");
    const marks = question.mark !== undefined && question.mark !== "" && question.maxmark !== undefined ? `, mark ${htmlToText(question.mark)} / ${number(question.maxmark)}` : "";
    const head = `### ${label ? `Question ${label}` : "Information"} (${question.type ?? "unknown type"})${question.status ? ` — ${htmlToText(question.status)}` : ""}${marks}`;
    return `${head}\n${truncate(questionHtmlToText(question.html), MAX_QUESTION_CHARS)}`;
  });
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}`;
}
