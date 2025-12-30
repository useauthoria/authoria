#!/bin/bash

# Script to prepare Supabase functions for deployment by copying backend code
# This makes the backend code accessible to Supabase Edge Functions

set -e

echo "🔧 Preparing Supabase functions for deployment..."

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTIONS_DIR="$PROJECT_ROOT/supabase/functions"
BACKEND_SRC="$PROJECT_ROOT/backend/src"
TARGET_DIR="$FUNCTIONS_DIR/backend/src"

# Clean up any existing backend copy
if [ -d "$TARGET_DIR" ]; then
  echo "🧹 Cleaning up existing backend copy..."
  rm -rf "$TARGET_DIR"
fi

# Copy backend/src to supabase/functions/backend/src
echo "📦 Copying backend code to functions directory..."
mkdir -p "$(dirname "$TARGET_DIR")"
cp -r "$BACKEND_SRC" "$TARGET_DIR"

echo "✅ Backend code copied successfully!"
echo "📝 Note: Import paths in functions should use '../backend/src/' instead of '../../../backend/src/'"

