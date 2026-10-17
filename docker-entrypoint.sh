#!/bin/sh
# Starts as root only long enough to make sure the mounted /data folder is
# writable by the app user, then drops to that user to run the app.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
