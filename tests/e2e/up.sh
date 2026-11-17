#!/usr/bin/env bash
# Starts a local Moodle in Docker, installs it and loads the test fixtures.
# Usage: tests/e2e/up.sh   (then: npm run test:e2e)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${MOODLE_E2E_PORT:-8099}"
BRANCH="${MOODLE_E2E_BRANCH:-MOODLE_405_STABLE}"
URL="http://localhost:${PORT}"
dc() { docker compose "$@"; }
in_moodle() { dc exec -T -u www-data moodle "$@"; }

dc up -d
# The image creates the data folder as root when it is a fresh volume.
dc exec -T moodle chown www-data:www-data /var/www/moodledata

if ! dc exec -T moodle test -f /var/www/html/version.php; then
  echo "Downloading Moodle ${BRANCH}…"
  dc exec -T moodle bash -c "curl -fsSL https://github.com/moodle/moodle/archive/refs/heads/${BRANCH}.tar.gz | tar xz --strip-components=1 -C /var/www/html && chown -R www-data:www-data /var/www/html"
fi

echo "Waiting for the database…"
for _ in $(seq 1 60); do
  dc exec -T db pg_isready -U moodle -q && break
  sleep 1
done

if ! dc exec -T moodle test -f /var/www/html/config.php; then
  echo "Installing Moodle (takes a few minutes)…"
  in_moodle php /var/www/html/admin/cli/install.php \
    --non-interactive --agree-license \
    --wwwroot="${URL}" --dataroot=/var/www/moodledata \
    --dbtype=pgsql --dbhost=db --dbname=moodle --dbuser=moodle --dbpass=moodle \
    --fullname="Moodle MCP E2E" --shortname=e2e \
    --adminuser=admin --adminpass='Admin.1234' --adminemail=admin@example.com
fi

echo "Loading fixtures…"
in_moodle php /opt/e2e/fixtures.php > .fixtures.json

echo
echo "Moodle is ready at ${URL} (admin / Admin.1234, student1 / Student.1234, teacher1 / Teacher.1234)."
echo "Run the tests with: npm run test:e2e"
