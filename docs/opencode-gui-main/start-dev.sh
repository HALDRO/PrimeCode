#!/bin/bash

echo "🚀 Starting OpenCode VSCode Extension Development"
echo ""
echo "Building extension..."
npm run build

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build successful!"
    echo ""
    echo "Starting watch mode..."
    echo "Keep this terminal open while developing."
    echo ""
    echo "Now:"
    echo "1. Press F5 in VSCode/Cursor"
    echo "2. Or open Run & Debug panel and click the green play button"
    echo ""
    npm run watch
else
    echo "❌ Build failed. Please fix errors and try again."
    exit 1
fi
