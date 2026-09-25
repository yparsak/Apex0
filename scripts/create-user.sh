#!/usr/bin/env bash
# Creates a local user with a default password ("change_me"), replacing the
# old public POST /auth/register API so account creation always goes through
# whoever runs this script rather than being self-service.
#
# Usage: scripts/create-user.sh <username> <initials>

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "Error: username and initials are both required." >&2
  echo "Usage: $0 <username> <initials>" >&2
  exit 1
fi

node scripts/create-user.js "$1" "$2"
