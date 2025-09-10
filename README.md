<!-- markdownlint-disable -->
<div align="center">
<h1>CodeQL Scanner VSCode Extension</h1>

<img src="./src/assets/VS-marketplace-CodeQL-icon.png" width="250" title="CodeQL Scanner">

[![Version](https://img.shields.io/visual-studio-marketplace/v/GeekMasher.codeql-scanner-vscode?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=GeekMasher.codeql-scanner-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/GeekMasher.codeql-scanner-vscode?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=GeekMasher.codeql-scanner-vscode)
[![GitHub Stars](https://img.shields.io/github/stars/GeekMasher/codeql-scanner-vscode?style=for-the-badge)][github]
[![GitHub Issues](https://img.shields.io/github/issues/GeekMasher/codeql-scanner-vscode?style=for-the-badge)][github-issues]
[![License](https://img.shields.io/github/license/GeekMasher/codeql-scanner-vscode?style=for-the-badge)][license]

</div>
<!-- markdownlint-restore -->

## 🔍 Supercharge Your Code Security with CodeQL

Seamlessly integrate GitHub's powerful CodeQL scanning engine directly into your VS Code workflow. Detect vulnerabilities, find security flaws, and improve code quality without leaving your editor.

> [!NOTE]
> This is **not** an offical GitHub project

## ✨ Key Features

- **🛡️ Instant Security Analysis**: Scan your code for vulnerabilities directly from VSCode
- **🔄 Real-Time Feedback**: Get immediate security insights as you code
- **📊 Rich Result Visualization**: View detailed vulnerability reports with syntax highlighting and data flow paths
- **🌊 Data Flow Analysis**: Trace security issues from source to sink with intuitive navigation
- **🔄 GitHub Integration**: Connect to GitHub for enhanced scanning capabilities and team collaboration
- **⚙️ Flexible Configuration**: Choose between local and remote scanning options to suit your workflow
- **🧰 Multi-Language Support**: Analyze JavaScript, TypeScript, Python, Java, C#, C/C++, Go, Ruby, Swift, Kotlin, and others code
  - **📜 Custom Extractors**: Supports custom CodeQL extractors

## 🚀 Getting Started

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=GeekMasher.codeql-scanner-vscode)
2. Configure your GitHub token (optional for enhanced features)
3. Open any code repository
4. Run a scan using the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`): `CodeQL: Run Scan`

## 📸 Showcase

Here are some screenshots showcasing the extension's capabilities:

<!-- markdownlint-disable -->
<details>
<summary>CodeQL Scanner Scan and Alert Summary</summary>

<div align="center">
<img src="./assets/showcase-scan-summary.png" title="CodeQL Scanner Scan and Alert Summary">
</div>
</details>

<details>
<summary>CodeQL Scanner Configuration Menu / Settings</summary>

<div align="center">
<img src="./assets/showcase-configuration.png" title="CodeQL Scanner Configuration Menu">
</div>
</details>

<details>
<summary>CodeQL Scanner Results Tree Viewer</summary>

<div align="center">
<img src="./assets/showcase-results.png" title="CodeQL Scanner Results Tree Viewer">
</div>
</details>


## 📋 Prerequisites

- **CodeQL CLI**: The extension can automatically install the [CodeQL CLI](https://github.com/github/codeql-cli-binaries/releases) for you
  - ✨ **Auto-Discovery**: The extension will automatically detect CodeQL CLI from GitHub's CodeQL extension if installed
  - ✨ **Auto-Install**: If CodeQL CLI is not found, the extension will offer to download and install it automatically
  - **Manual Install**: You can also download the latest release manually from the [CodeQL CLI releases page](https://github.com/github/codeql-cli-binaries/releases) and configure the path in settings
  - **Verification**: Use `CodeQL: Show CLI Information` command to check your installation

- **GitHub Personal Access Token**: For GitHub integration features, a GitHub token with appropriate permissions is required
  - Create a token at [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
  - Required permissions: `repo`, `read:org` (for organization repositories), `security_events` (for security alerts)
  - Store the token securely in your extension settings

## 📋 Available Commands

| Command                            | Description                                    |
| ---------------------------------- | ---------------------------------------------- |
| `CodeQL: Run Scan`                 | Start a security scan on the current workspace |
| `CodeQL: Initialize Repository`    | Set up CodeQL for the current repository       |
| `CodeQL: Run Analysis`             | Execute a full code analysis                   |
| `CodeQL: Configure Settings`       | Open the extension settings                    |
| `CodeQL: Show Logs`                | View the extension's log output                |
| `CodeQL: Clear Logs`               | Clear all log entries                          |
| `CodeQL: Clear Inline Diagnostics` | Remove inline problem markers                  |
| `CodeQL: Show CLI Information`     | Display information about the CodeQL CLI       |
| `CodeQL: Install/Update CLI`       | ✨ Download and install CodeQL CLI automatically |
| `CodeQL: Copy Flow Path`           | Copy vulnerability data flow path to clipboard |
| `CodeQL: Navigate Flow Steps`      | Step through vulnerability data flow paths     |

## ⚙️ Configuration Options

The extension provides several configuration options to customize its behavior:

```json
{
  "codeql-scanner.github.token": "your-github-token",
  "codeql-scanner.codeqlPath": "codeql",
  "codeql-scanner.autoDetectGitHubExtension": true,
  "codeql-scanner.autoInstallCodeQL": true,
  "codeql-scanner.useLocalScan": true
}
```

### Key Configuration Options

- **`autoDetectGitHubExtension`** (default: `true`): Automatically detect and use CodeQL CLI from GitHub's CodeQL extension if available
- **`autoInstallCodeQL`** (default: `true`): Automatically download and install CodeQL CLI from GitHub if not found
- **`codeqlPath`**: Path to the CodeQL CLI executable (automatically configured when using auto-install)
- **`useLocalScan`** (default: `true`): Use local CodeQL CLI for scanning instead of GitHub Actions

## 💡 Why CodeQL Scanner?

CodeQL is GitHub's semantic code analysis engine that lets you query code as if it were data. This extension brings that power directly into VS Code, allowing you to:

- Detect potential security vulnerabilities early in development
- Understand complex security issues with clear data flow visualization
- Integrate advanced security scanning into your daily coding workflow
- Improve code quality with actionable insights

## 🔗 Integration with GitHub

Connect the extension to GitHub for enhanced capabilities:

- Access GitHub's vast CodeQL query library
- Synchronize with your GitHub repositories
- View and manage GitHub code scanning alerts

## 🛠️ Development

Want to contribute? Great! You can:

1. Clone the repository: `git clone https://github.com/geekmasher/codeql-scanner-vscode.git`
2. Install dependencies: `npm install`
3. Build the extension: `npm run compile`
4. Run tests: `npm run test`

## 📜 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🙏 Acknowledgements

- Built on GitHub's powerful [CodeQL](https://github.com/github/codeql) engine
- Inspired by the need for accessible security tools for all developers

---

Happy Secure Coding! 🔒✨

<!-- Links -->

[github]: https://github.com/geekmasher/codeql-scanner-vscode
[github-issues]: https://github.com/geekmasher/codeql-scanner-vscode/issues
[license]: ./LICENSE
