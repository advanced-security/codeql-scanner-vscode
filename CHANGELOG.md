# Changelog

All notable changes to the CodeQL Scanner VSCode extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-06-26

### Added
- Initial release of CodeQL Scanner extension
- **Local CodeQL CLI Integration**:
  - Support for local CodeQL CLI scanning using subprocess execution
  - Automatic database creation using `codeql database create` with build mode detection
  - Analysis execution using `codeql database analyze` with customizable query suites
  - SARIF result parsing and display with flow step tracking
  - Storage of databases and results in `$HOME/.codeql/databases/` and `$HOME/.codeql/results/`
  - CodeQL version detection and compatibility checking
  - Automatic query pack resolution and installation
  - Git SHA-based result file naming for version tracking
- **GitHub API Integration**:
  - Connect to GitHub repositories using personal access tokens
  - Repository information retrieval with language detection
  - GitHub Actions workflow creation and management
  - Remote scanning via GitHub Actions with workflow dispatch
  - CodeQL alerts fetching from GitHub Security tab
  - GitHub Enterprise Server support with configurable base URL
  - Automatic repository owner/name detection from git remotes
- **Dual Scanning Modes**:
  - Local CLI scanning (default and recommended) with offline capability
  - Remote GitHub Actions scanning with real-time status monitoring
  - Hybrid remote alert fetching for existing GitHub CodeQL results
- **Advanced Configuration Management**:
  - Modern webview-based configuration panel with real-time updates
  - Auto-save functionality for configuration changes
  - Threat model selection (Remote/Local) for targeted analysis
  - Query suites selection (default, security-extended, security-and-quality)
  - Programming language auto-detection and manual selection
  - CodeQL CLI path configuration with validation
  - GitHub repository language auto-mapping to CodeQL languages
- **Comprehensive Results Visualization**:
  - Tree view for scan results organized by severity levels
  - Click-to-navigate to exact source code locations with highlighting
  - Data flow visualization with step-by-step navigation
  - Real-time result updates during scanning
  - Security dashboard with vulnerability statistics
  - Top vulnerabilities and affected files summary
  - Severity-based color coding (Critical, High, Medium, Low)
  - Auto-loading of existing SARIF files on startup
- **Rich Command Set**:
  - `CodeQL: Run Scan` - Execute local or remote security analysis
  - `CodeQL: Initialize Repository` - Setup configuration files and workflows
  - `CodeQL: Run Analysis` - View analysis history from GitHub
  - `CodeQL: Configure Settings` - Open interactive configuration panel
  - `CodeQL: Show Logs` - Display extension logs for debugging
  - `CodeQL: Clear Logs` - Clear extension log history
  - `CodeQL: Clear Inline Diagnostics` - Remove VS Code diagnostics
  - `CodeQL: Copy Flow Path` - Copy data flow paths to clipboard
  - `CodeQL: Navigate Flow Steps` - Step through vulnerability flow
  - `CodeQL: Reload SARIF` - Refresh existing scan results
- **Automated File Generation**:
  - `.github/codeql/codeql-config.yml` with customizable paths and exclusions
  - `.github/workflows/codeql-analysis.yml` with multi-language matrix
  - YAML configuration using js-yaml library with proper formatting
  - Workflow dispatch inputs for flexible GitHub Actions execution
- **Extended Multi-language Support**:
  - JavaScript, TypeScript, Python, Java, C#, C/C++, Go, Ruby, Swift, Kotlin, Scala
  - Language-specific database creation with appropriate build modes
  - Dynamic language detection from CodeQL CLI capabilities
  - GitHub repository language mapping and auto-selection
  - Language filtering and exclusion capabilities
- **Enhanced User Experience**:
  - Progressive loading indicators with duration tracking
  - Auto-save indicators for configuration changes
  - Animated success/error feedback with visual cues
  - Responsive design for different screen sizes
  - Intelligent error handling with actionable messages
  - Background SARIF file auto-loading
  - Real-time scan progress with detailed status updates

### Technical Details
- Built with TypeScript and VS Code Extension API
- Uses @octokit/rest for comprehensive GitHub API integration
- Implements subprocess execution for CodeQL CLI with proper error handling
- Advanced SARIF result format parsing with flow step extraction
- Modern webview provider with CSS animations and responsive design
- Tree data provider with context menu actions
- Real-time communication between webview and extension
- Sophisticated logging system with configurable levels
- Background task management and cancellation support
- Memory-efficient result caching and management

### Dependencies
- @octokit/rest: GitHub API client with full CodeQL support
- js-yaml: YAML parsing and generation for configuration files
- axios: HTTP client for additional API calls and error handling
- VS Code Extension API: Core functionality and UI integration

### Configuration Properties
- `codeql-scanner.github.token`: GitHub API authentication token
- `codeql-scanner.github.owner`: Repository owner/organization name
- `codeql-scanner.github.repo`: Repository name
- `codeql-scanner.github.baseUrl`: GitHub API base URL (Enterprise support)
- `codeql-scanner.github.languages`: Auto-detected repository languages
- `codeql-scanner.suites`: CodeQL query suites (array support)
- `codeql-scanner.threatModel`: Analysis threat model (Remote/Local)
- `codeql-scanner.languages`: Programming languages to analyze (array)
- `codeql-scanner.codeqlPath`: Path to CodeQL CLI executable
- `codeql-scanner.useLocalScan`: Enable local CLI scanning mode
- `codeql-scanner.logging.level`: Logging verbosity (DEBUG/INFO/WARN/ERROR)
- `codeql-scanner.logging.enableConsole`: Enable console logging for development

### Activity Bar Integration
- Dedicated CodeQL Scanner activity bar with shield icon
- Scan Results view (conditional display when results available)
- Configuration webview panel for settings management
- Context menu integration in file explorer
- Result item context menus for flow navigation and copying
