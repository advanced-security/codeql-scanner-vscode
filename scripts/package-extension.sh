#!/bin/bash

# Package Extension Script
# Creates a .vsix package for the CodeQL Scanner extension

echo "📦 Packaging CodeQL Scanner Extension..."
echo ""

# Parse command line arguments
INSTALL_FLAG=false
for arg in "$@"; do
    case $arg in
        --install|-i)
            INSTALL_FLAG=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--install|-i] [--help|-h]"
            echo ""
            echo "Options:"
            echo "  --install, -i    Automatically install the extension after packaging"
            echo "  --help, -h       Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "Installing vsce (Visual Studio Code Extension CLI)..."
    npm install -g vsce
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install vsce. Please install manually: npm install -g vsce"
        exit 1
    fi
fi

# Compile the extension
echo "Compiling TypeScript..."
npm run compile
if [ $? -ne 0 ]; then
    echo "❌ Compilation failed"
    exit 1
fi

# Run linting
echo "Running linter..."
npm run lint
if [ $? -ne 0 ]; then
    echo "⚠️  Linting issues found, but continuing with packaging..."
fi

# Package the extension
echo "Creating .vsix package..."
vsce package
if [ $? -eq 0 ]; then
    echo "✅ Extension packaged successfully!"
    
    # Get the generated .vsix file
    VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -n1)
    
    if [ -z "$VSIX_FILE" ]; then
        echo "❌ No .vsix file found after packaging"
        exit 1
    fi
    
    echo ""
    echo "Generated package: $VSIX_FILE"
    ls -la "$VSIX_FILE"
    
    # Auto-install if flag is set
    if [ "$INSTALL_FLAG" = true ]; then
        echo ""
        echo "🚀 Installing extension automatically..."
        
        # Check if VS Code CLI is available
        if command -v code &> /dev/null; then
            code --install-extension "$VSIX_FILE"
            if [ $? -eq 0 ]; then
                echo "✅ Extension installed successfully!"
                echo "   Restart VS Code to activate the extension."
            else
                echo "❌ Failed to install extension automatically"
                echo "   Please install manually using the instructions below."
                INSTALL_FLAG=false
            fi
        else
            echo "❌ VS Code CLI not found. Cannot auto-install."
            echo "   Make sure VS Code is installed and the 'code' command is available in PATH."
            echo "   Please install manually using the instructions below."
            INSTALL_FLAG=false
        fi
    else
        echo ""
        echo "To install the extension manually:"
        echo "1. Open VS Code"
        echo "2. Go to Extensions view (Cmd+Shift+X on Mac, Ctrl+Shift+X on Windows/Linux)"
        echo "3. Click '...' menu → 'Install from VSIX...'"
        echo "4. Select the file: $VSIX_FILE"
        echo ""
        echo "Or use the command line:"
        echo "  code --install-extension $VSIX_FILE"
    fi
else
    echo "❌ Packaging failed"
    exit 1
fi