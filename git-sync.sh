#!/bin/bash

msg="$1"

if [ -z "$msg" ]; then
  msg="Update"
fi

echo "🔄 Staging changes..."
git add .

echo "📝 Committing..."
git commit -m "$msg"

echo "⬆️  Pushing..."
git push

echo "✅ Done!"
