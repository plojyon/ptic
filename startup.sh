#!/bin/bash
while true; do
  echo "Starting bot..."
  node index.js 2> err.log || tail -c 1500 err.log | bash .webhook.sh
  echo "Bot crashed with exit code $? — restarting in 3 seconds..."
  sleep 3
done

