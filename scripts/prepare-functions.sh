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

# Fix imports in copied files to include .ts extensions for Deno compatibility
# Only add .ts if it's not already present
echo "🔧 Fixing import paths for Deno compatibility..."
find "$TARGET_DIR" -name "*.ts" -type f -exec sed -i '' \
  -e "s|from '\.\./integrations/ShopifyClient'\([^.]\)|from '../integrations/ShopifyClient.ts'\1|g" \
  -e "s|from \"\.\./integrations/ShopifyClient\"\([^.]\)|from \"../integrations/ShopifyClient.ts\"\1|g" \
  -e "s|from '\.\./utils/\([^'.]*\)'\([^.]\)|from '../utils/\1.ts'\2|g" \
  -e "s|from \"\.\./utils/\([^\".]*\)\"\([^.]\)|from \"../utils/\1.ts\"\2|g" \
  -e "s|from '\.\./core/\([^'.]*\)'\([^.]\)|from '../core/\1.ts'\2|g" \
  -e "s|from \"\.\./core/\([^\".]*\)\"\([^.]\)|from \"../core/\1.ts\"\2|g" \
  -e "s|from '\./\([^'.]*\)'\([^.]\)|from './\1.ts'\2|g" \
  -e "s|from \"\./\([^\".]*\)\"\([^.]\)|from \"./\1.ts\"\2|g" \
  -e "s|from '\.\([^']*\)\.ts\.ts'|from '.\1.ts'|g" \
  -e "s|from \"\.\([^\"]*\)\.ts\.ts\"|from \".\1.ts\"|g" \
  {} \;

echo "✅ Backend code copied and imports fixed successfully!"
echo "📝 Note: Import paths in functions should use '../backend/src/' instead of '../../../backend/src/'"

