<?php
// Builds the course the end-to-end tests run against, inside the throwaway
// Moodle started by up.sh. Running it again deletes the course and rebuilds
// it, so every run starts from the same state. Prints the ids as JSON.

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->libdir . '/testing/classes/util.php');
require_once($CFG->libdir . '/moodlelib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');
require_once($CFG->dirroot . '/message/lib.php');
require_once($CFG->dirroot . '/calendar/lib.php');

\core\session\manager::set_user(get_admin());

// ---- site settings: what the mobile app (and so moodle-mcp) needs.
set_config('enablewebservices', 1);
set_config('webserviceprotocols', 'rest');
set_config('enablemobilewebservice', 1);
$DB->set_field('external_services', 'enabled', 1, ['shortname' => 'moodle_mobile_app']);
// Turning the mobile service on in the admin pages also grants this; here it has to be done by hand.
assign_capability('webservice/rest:use', CAP_ALLOW, $CFG->defaultuserroleid, \context_system::instance()->id, true);
set_config('messaging', 1);
set_config('enablecompletion', 1);
set_config('noreplyaddress', 'noreply@example.com');
// Nothing here should ever try to send real email.
$CFG->noemailever = true;
// Lets the tests log in with simple fixed passwords.
set_config('passwordpolicy', 0);

$gen = \testing_util::get_data_generator();

// ---- start clean.
if ($old = $DB->get_record('course', ['shortname' => 'E2E'])) {
    delete_course($old, false);
}

function e2e_user($gen, string $username, string $password, string $first, string $last) {
    global $DB;
    if ($user = $DB->get_record('user', ['username' => $username, 'deleted' => 0])) {
        // Leftovers of the previous run.
        $DB->delete_records('notifications', ['useridto' => $user->id]);
        $DB->delete_records('event', ['userid' => $user->id, 'eventtype' => 'user']);
        return $user;
    }
    return $gen->create_user([
        'username' => $username, 'password' => $password,
        'firstname' => $first, 'lastname' => $last, 'email' => "$username@example.com",
    ]);
}

$student = e2e_user($gen, 'student1', 'Student.1234', 'Sara', 'Estudiante');
$mate = e2e_user($gen, 'student2', 'Student.1234', 'Marcos', 'Compañero');
$teacher = e2e_user($gen, 'teacher1', 'Teacher.1234', 'Ana', 'Profesora');

$course = $gen->create_course(['fullname' => 'Curso de pruebas E2E', 'shortname' => 'E2E', 'enablecompletion' => 1, 'numsections' => 3]);
$gen->enrol_user($student->id, $course->id, 'student');
$gen->enrol_user($mate->id, $course->id, 'student');
$gen->enrol_user($teacher->id, $course->id, 'editingteacher');
$group = $gen->create_group(['courseid' => $course->id, 'name' => 'Grupo A']);
$gen->create_group_member(['groupid' => $group->id, 'userid' => $student->id]);
$gen->create_group_member(['groupid' => $group->id, 'userid' => $mate->id]);

$now = time();
$day = 86400;

// ---- assignments.
$assign = function (string $name, array $extra) use ($gen, $course, $now, $day) {
    return $gen->create_module('assign', array_merge([
        'course' => $course->id, 'name' => $name, 'section' => 1,
        'duedate' => $now + 7 * $day, 'cutoffdate' => 0, 'allowsubmissionsfromdate' => 0,
        'assignsubmission_file_enabled' => 1, 'assignsubmission_file_maxfiles' => 3,
        'assignsubmission_file_maxsizebytes' => 1024 * 1024,
        'assignsubmission_onlinetext_enabled' => 0, 'submissiondrafts' => 1,
        'requiresubmissionstatement' => 0, 'teamsubmission' => 0,
    ], $extra));
};
$ids = ['assign' => []];
$ids['assign']['draft'] = (int)$assign('Práctica con borrador', ['assignsubmission_onlinetext_enabled' => 1])->id;
$ids['assign']['direct'] = (int)$assign('Práctica sin borrador', ['submissiondrafts' => 0, 'cutoffdate' => $now + 10 * $day, 'assignsubmission_file_maxfiles' => 2])->id;
$ids['assign']['submitted'] = (int)$assign('Práctica ya entregada', [])->id;
$ids['assign']['closed'] = (int)$assign('Práctica cerrada', ['duedate' => $now - 5 * $day, 'cutoffdate' => $now - 2 * $day])->id;
$ids['assign']['pdfonly'] = (int)$assign('Práctica solo PDF', ['assignsubmission_file_filetypes' => '.pdf'])->id;
$ids['assign']['textonly'] = (int)$assign('Reflexión escrita', ['submissiondrafts' => 0, 'assignsubmission_file_enabled' => 0, 'assignsubmission_onlinetext_enabled' => 1])->id;
$ids['assign']['team'] = (int)$assign('Trabajo en grupo', ['teamsubmission' => 1])->id;
$ids['assign']['statement'] = (int)$assign('Práctica con declaración', ['submissiondrafts' => 0, 'requiresubmissionstatement' => 1])->id;

// ---- forums: one students can post in, and the announcements forum they cannot.
$forum = $gen->create_module('forum', ['course' => $course->id, 'name' => 'Dudas de la asignatura', 'type' => 'general', 'section' => 1]);
$news = forum_get_course_forum($course->id, 'news');
$forumgen = $gen->get_plugin_generator('mod_forum');
$discussion = $forumgen->create_discussion([
    'course' => $course->id, 'forum' => $forum->id, 'userid' => $teacher->id,
    'name' => 'Dudas sobre la práctica 1', 'message' => '<p>Escribid aquí vuestras dudas.</p>',
]);
$forumgen->create_discussion([
    'course' => $course->id, 'forum' => $news->id, 'userid' => $teacher->id,
    'name' => 'Bienvenida', 'message' => '<p>Bienvenidos al curso.</p>',
]);
$ids['forum'] = ['general' => (int)$forum->id, 'news' => (int)$news->id, 'discussion' => (int)$discussion->id, 'firstpost' => (int)$discussion->firstpost];

// ---- completion: by hand, automatic and none.
$page = function (string $name, array $extra) use ($gen, $course) {
    return $gen->create_module('page', array_merge(['course' => $course->id, 'name' => $name, 'section' => 2, 'content' => '<p>Texto</p>'], $extra));
};
$ids['cm'] = [
    'manual' => (int)$page('Lectura del tema 1', ['completion' => COMPLETION_TRACKING_MANUAL])->cmid,
    'automatic' => (int)$page('Lectura del tema 2', ['completion' => COMPLETION_TRACKING_AUTOMATIC, 'completionview' => 1])->cmid,
    'none' => (int)$page('Lectura opcional', ['completion' => COMPLETION_TRACKING_NONE])->cmid,
];

// ---- quizzes: a finished attempt that can be reviewed, one that cannot, and one still open.
// Questions come from a GIFT import: Moodle's own question generator only works inside PHPUnit.
require_once($CFG->dirroot . '/question/format.php');
require_once($CFG->dirroot . '/question/format/gift/format.php');
$coursecontext = \context_course::instance($course->id);
$category = $gen->get_plugin_generator('core_question')->create_question_category(['contextid' => $coursecontext->id]);
$gift = <<<'GIFT'
::Capital::¿Cuál es la capital de Francia? {=París#Correcto. ~Lyon#No, Lyon es la tercera ciudad. ~Marsella ~Niza}

::Anfibio::Nombra un anfibio verde que croa. {=rana =sapo}

::Agua::El agua hierve a 100 grados al nivel del mar. {TRUE}
GIFT;
$giftfile = make_request_directory() . '/preguntas.gift';
file_put_contents($giftfile, $gift);
$import = new \qformat_gift();
$import->setCategory($category);
$import->setContexts([$coursecontext]);
$import->setCourse($course);
$import->setFilename($giftfile);
$import->setRealfilename('preguntas.gift');
$import->setMatchgrades('error');
$import->setCatfromfile(false);
$import->setContextfromfile(false);
$import->setStoponerror(true);
ob_start();
$imported = $import->importpreprocess() && $import->importprocess() && $import->importpostprocess();
ob_end_clean();
if (!$imported || count($import->questionids) !== 3) {
    throw new \moodle_exception('Could not import the test questions.');
}
$questionids = $import->questionids;
$make_quiz = function (string $name, array $extra) use ($gen, $course, $questionids) {
    $quiz = $gen->create_module('quiz', array_merge([
        'course' => $course->id, 'name' => $name, 'section' => 3, 'grade' => 10, 'questionsperpage' => 0, 'shuffleanswers' => 0,
    ], $extra));
    foreach ($questionids as $questionid) {
        quiz_add_quiz_question($questionid, $quiz, 0, 1);
    }
    \mod_quiz\quiz_settings::create($quiz->id)->get_grade_calculator()->recompute_quiz_sumgrades();
    return $quiz;
};
$attempt_quiz = function ($quiz, $user, bool $finish) {
    $quizobj = \mod_quiz\quiz_settings::create($quiz->id, $user->id);
    $quba = \question_engine::make_questions_usage_by_activity('mod_quiz', $quizobj->get_context());
    $quba->set_preferred_behaviour($quizobj->get_quiz()->preferredbehaviour);
    $timenow = time();
    $attempt = quiz_create_attempt($quizobj, 1, false, $timenow, false, $user->id);
    quiz_start_new_attempt($quizobj, $quba, $attempt, 1, $timenow);
    quiz_attempt_save_started($quizobj, $quba, $attempt);
    if ($finish) {
        $attemptobj = \mod_quiz\quiz_attempt::create($attempt->id);
        // Simulated answers name the choice by its text. Slot 1: Lyon (wrong). Slot 2: "rana" (right). Slot 3: true (right).
        $attemptobj->process_submitted_actions($timenow, false, [1 => ['answer' => 'Lyon'], 2 => ['answer' => 'rana'], 3 => ['answer' => 1]]);
        $attemptobj = \mod_quiz\quiz_attempt::create($attempt->id);
        $attemptobj->process_finish($timenow, false);
    }
    return (int)$attempt->id;
};
$hidden = [];
foreach (['attempt', 'correctness', 'maxmarks', 'marks', 'specificfeedback', 'generalfeedback', 'rightanswer', 'overallfeedback'] as $what) {
    foreach (['during', 'immediately', 'open', 'closed'] as $when) {
        $hidden[$what . $when] = 0;
    }
}
\core\session\manager::set_user($student);
$reviewable = $make_quiz('Test del tema 1', []);
$unreviewable = $make_quiz('Test del tema 2 (sin revisión)', $hidden);
$open = $make_quiz('Test del tema 3', ['timeclose' => $now + 3 * $day, 'timelimit' => 1800, 'attempts' => 2]);
$ids['quiz'] = [
    'reviewable' => (int)$reviewable->id, 'unreviewable' => (int)$unreviewable->id, 'open' => (int)$open->id,
    'attempt_finished' => $attempt_quiz($reviewable, $student, true),
    'attempt_noreview' => $attempt_quiz($unreviewable, $student, true),
    'attempt_inprogress' => $attempt_quiz($open, $student, false),
];
\core\session\manager::set_user(get_admin());

// ---- calendar: a course event (an exam) that students can see but not delete.
$exam = $gen->create_event([
    'name' => 'Examen parcial', 'eventtype' => 'course', 'courseid' => $course->id, 'userid' => $teacher->id,
    'timestart' => $now + 5 * $day, 'timeduration' => 7200, 'description' => '<p>Aula 12. Traed calculadora.</p>',
]);
$ids['event'] = ['exam' => (int)$exam->id];

// ---- notifications and a private message for the student.
$notify = function (string $subject, string $body) use ($student, $teacher, $course) {
    $message = new \core\message\message();
    $message->component = 'mod_assign';
    $message->name = 'assign_notification';
    $message->notification = 1;
    $message->courseid = $course->id;
    $message->userfrom = $teacher;
    $message->userto = $student;
    $message->subject = $subject;
    $message->fullmessage = $body;
    $message->fullmessageformat = FORMAT_PLAIN;
    $message->fullmessagehtml = "<p>$body</p>";
    $message->smallmessage = $subject;
    $message->contexturl = (new \moodle_url('/course/view.php', ['id' => $course->id]))->out(false);
    $message->contexturlname = 'Curso';
    return (int)message_send($message);
};
$ids['notification'] = [
    'first' => $notify('Tu práctica ha sido calificada', 'Has obtenido un 8,5 en la práctica 1.'),
    'second' => $notify('Cambio de aula', 'La clase del jueves será en el aula 14.'),
    'third' => $notify('Recordatorio', 'El examen parcial es la semana que viene.'),
];
$conversationid = \core_message\api::get_conversation_between_users([$teacher->id, $student->id]);
if ($conversationid) {
    // Left over from the previous run.
    $DB->delete_records('messages', ['conversationid' => $conversationid]);
} else {
    $conversationid = \core_message\api::create_conversation(
        \core_message\api::MESSAGE_CONVERSATION_TYPE_INDIVIDUAL, [$teacher->id, $student->id])->id;
}
\core_message\api::send_message_to_conversation($teacher->id, $conversationid, 'Hola Sara, ¿puedes pasarte por mi despacho el lunes?', FORMAT_HTML);
$ids['conversation'] = (int)$conversationid;

$ids['course'] = (int)$course->id;
$ids['users'] = ['student' => (int)$student->id, 'mate' => (int)$mate->id, 'teacher' => (int)$teacher->id];
$ids['group'] = (int)$group->id;

echo json_encode($ids, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), "\n";
