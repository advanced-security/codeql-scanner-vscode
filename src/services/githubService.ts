import { Octokit } from "@octokit/rest";
import * as vscode from "vscode";
import { LoggerService } from "./loggerService";
import { CodeQLService } from "./codeqlService";

export interface RepositoryInfo {
  owner: string;
  repo: string;
  instance: string; // GitHub instance URL (e.g., github.com, github.enterprise.com)
  defaultBranch: string;
  languages: string[];
  isPrivate: boolean;
  codeqlEnabled: boolean;
}

export interface CodeQLAnalysis {
  id: number;
  ref: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  resultsCount?: number;
  url: string;
}

export class GitHubService {
  private octokit: Octokit | null = null;
  private logger: LoggerService;

  constructor() {
    this.logger = LoggerService.getInstance();
    this.initialize();
  }

  private initialize() {
    const config = vscode.workspace.getConfiguration("codeql-scanner");

    const token = config.get<string>("github.token");
    const baseUrl = config.get<string>(
      "github.baseUrl",
      "https://api.github.com"
    );

    if (token) {
      config.update("github.token", token, vscode.ConfigurationTarget.Global);

      this.octokit = new Octokit({
        auth: token,
        baseUrl: baseUrl,
      });
      this.logger.info(
        "GitHubService",
        "GitHub token configured successfully",
        { baseUrl }
      );
    } else if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      var envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      this.octokit = new Octokit({
        auth: envToken,
        baseUrl: baseUrl,
      });
      this.logger.info(
        "GitHubService",
        "GitHub token configured from environment variable",
        { baseUrl }
      );
      config.update(
        "github.token",
        envToken,
        vscode.ConfigurationTarget.Global
      );
    } else {
      this.logger.warn(
        "GitHubService",
        "GitHub token not configured. Some features may not work."
      );
    }

    this.getRepositoryInfo()
      .then((repoInfo) => {
        this.logger.info(
          "GitHubService",
          "Repository info fetched successfully",
          repoInfo
        );

        config.update(
          "github.owner",
          repoInfo.owner,
          vscode.ConfigurationTarget.Workspace
        )
        config.update(
          "github.repo",
          repoInfo.repo,
          vscode.ConfigurationTarget.Workspace
        )

        if (repoInfo.codeqlEnabled === false) {
          // Send error to the users
          vscode.window
            .showErrorMessage(
              `CodeQL is not enabled for the repository ${repoInfo.owner}/${repoInfo.repo}. Please enable CodeQL analysis in your repository settings.`,
              "Learn More"
            )
            .then((selection) => {
              if (selection === "Learn More") {
                vscode.env.openExternal(
                  vscode.Uri.parse(
                    "https://docs.github.com/en/code-security/secure-coding/using-codeql-code-scanning-in-your-repository"
                  )
                );
              }
            });

        }
      })
      .catch((error) => {
        this.logger.error(
          "GitHubService",
          "Failed to fetch repository info",
          error
        );
      });
  }

  /**
   * Update the GitHub token used for authentication.
   * @param token GitHub token to use for authentication
   */
  public updateToken(token: string) {
    this.octokit = new Octokit({
      auth: token,
    });
    this.logger.info("GitHubService", "GitHub token updated");
    vscode.workspace
      .getConfiguration("codeql-scanner")
      .update("github.token", token, vscode.ConfigurationTarget.Global);
  }

  public async getRepositoryInfo(): Promise<RepositoryInfo> {
    this.logger.logServiceCall("GitHubService", "getRepositoryInfo", "started");

    if (!this.octokit) {
      const error = new Error("GitHub token not configured");
      this.logger.logServiceCall(
        "GitHubService",
        "getRepositoryInfo",
        "failed",
        error
      );
      throw error;
    }

    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const owner = config.get<string>("github.owner");
    const repo = config.get<string>("github.repo");

    if (!owner || !repo) {
      // Try to get from workspace git remote
      const gitInfo = await this.getGitInfo();
      if (gitInfo) {
        this.logger.info(
          "GitHubService",
          "Using git remote info for repository details",
          gitInfo
        );
        return await this.fetchRepositoryInfo(gitInfo.owner, gitInfo.repo);
      }
      const error = new Error("Repository owner and name must be configured");
      this.logger.logServiceCall(
        "GitHubService",
        "getRepositoryInfo",
        "failed",
        error
      );
      throw error;
    }

    const result = await this.fetchRepositoryInfo(owner, repo);
    this.logger.logServiceCall(
      "GitHubService",
      "getRepositoryInfo",
      "completed",
      { owner, repo }
    );
    return result;
  }

  private async fetchRepositoryInfo(
    owner: string,
    repo: string
  ): Promise<RepositoryInfo> {
    if (!this.octokit) {
      throw new Error("GitHub token not configured");
    }

    try {
      this.logger.logGitHubAPI(`repos/${owner}/${repo}`, "request");

      const [repoResponse, languagesResponse, codeqlResponse] =
        await Promise.all([
          this.octokit.repos.get({ owner, repo }),
          this.octokit.repos.listLanguages({ owner, repo }),
          this.getCodeQLStatus(owner, repo),
        ]);

      this.logger.logGitHubAPI(`repos/${owner}/${repo}`, "response", {
        languages: Object.keys(languagesResponse.data),
        isPrivate: repoResponse.data.private,
        codeqlEnabled: codeqlResponse,
      });

      // Determine the instance from the base URL
      const config = vscode.workspace.getConfiguration("codeql-scanner");
      const baseUrl = config.get<string>(
        "github.baseUrl",
        "https://api.github.com"
      );
      const instance = this.extractInstanceFromBaseUrl(baseUrl);

      const repoLanguages = Object.keys(languagesResponse.data);

      config.update(
        "github.languages",
        repoLanguages,
        vscode.ConfigurationTarget.WorkspaceFolder
      );

      this.logger.info(
        "GitHubService",
        `GitHub Languages for ${owner}/${repo}: ${repoLanguages.join(", ")}`
      );

      return {
        owner,
        repo,
        instance,
        defaultBranch: repoResponse.data.default_branch,
        languages: repoLanguages,
        isPrivate: repoResponse.data.private,
        codeqlEnabled: codeqlResponse,
      };
    } catch (error) {
      this.logger.logGitHubAPI(`repos/${owner}/${repo}`, "error", error);
      throw new Error(`Failed to fetch repository info: ${error}`);
    }
  }

  private async getCodeQLStatus(owner: string, repo: string): Promise<boolean> {
    if (!this.octokit) {
      return false;
    }

    try {
      this.logger.logGitHubAPI(
        `repos/${owner}/${repo}/code-scanning/alerts`,
        "request"
      );
      await this.octokit.codeScanning.listAlertsForRepo({ owner, repo });
      this.logger.debug(
        "GitHubService",
        `CodeQL is enabled for ${owner}/${repo}`
      );
      return true;
    } catch (error) {
      // CodeQL might not be enabled or we don't have permission
      this.logger.debug(
        "GitHubService",
        `CodeQL status check failed for ${owner}/${repo}`,
        error
      );
      return false;
    }
  }

  public async triggerCodeQLScan(
    owner: string,
    repo: string,
    ref?: string
  ): Promise<void> {
    this.logger.logServiceCall(
      "GitHubService",
      "triggerCodeQLScan",
      "started",
      { owner, repo, ref }
    );

    if (!this.octokit) {
      const error = new Error("GitHub token not configured");
      this.logger.logServiceCall(
        "GitHubService",
        "triggerCodeQLScan",
        "failed",
        error
      );
      throw error;
    }

    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const languages = config.get<string[]>("languages", [
      "javascript",
      "typescript",
    ]);

    try {
      // Try to trigger CodeQL analysis via workflow dispatch
      try {
        this.logger.logGitHubAPI(
          `repos/${owner}/${repo}/actions/workflows/codeql-analysis.yml/dispatches`,
          "request"
        );
        await this.octokit.actions.createWorkflowDispatch({
          owner,
          repo,
          workflow_id: "codeql-analysis.yml",
          ref: ref || "main",
          inputs: {
            languages: languages.join(","),
          },
        });
        this.logger.logServiceCall(
          "GitHubService",
          "triggerCodeQLScan",
          "completed"
        );
      } catch (workflowError) {
        // If workflow doesn't exist, suggest creating it
        const error = new Error(
          `CodeQL workflow not found. Run 'CodeQL: Initialize Repository' first. Error: ${workflowError}`
        );
        this.logger.logServiceCall(
          "GitHubService",
          "triggerCodeQLScan",
          "failed",
          error
        );
        throw error;
      }
    } catch (error) {
      this.logger.logServiceCall(
        "GitHubService",
        "triggerCodeQLScan",
        "failed",
        error
      );
      throw new Error(`Failed to trigger CodeQL scan: ${error}`);
    }
  }

  public async getCodeQLAnalyses(
    owner: string,
    repo: string
  ): Promise<CodeQLAnalysis[]> {
    this.logger.logServiceCall(
      "GitHubService",
      "getCodeQLAnalyses",
      "started",
      { owner, repo }
    );

    if (!this.octokit) {
      const error = new Error("GitHub token not configured");
      this.logger.logServiceCall(
        "GitHubService",
        "getCodeQLAnalyses",
        "failed",
        error
      );
      throw error;
    }

    try {
      this.logger.logGitHubAPI(
        `repos/${owner}/${repo}/code-scanning/alerts`,
        "request"
      );
      const response = await this.octokit.codeScanning.listAlertsForRepo({
        owner,
        repo,
        per_page: 50,
        state: "open",
      });

      const analyses = response.data.map((analysis: any) => ({
        id: analysis.number || analysis.id,
        ref: analysis.ref || "main",
        status: analysis.state || "unknown",
        createdAt: analysis.created_at,
        completedAt: analysis.updated_at || undefined,
        resultsCount: 1,
        url: analysis.html_url,
      }));

      this.logger.logServiceCall(
        "GitHubService",
        "getCodeQLAnalyses",
        "completed",
        { count: analyses.length }
      );
      return analyses;
    } catch (error) {
      this.logger.logServiceCall(
        "GitHubService",
        "getCodeQLAnalyses",
        "failed",
        error
      );
      throw new Error(`Failed to get CodeQL analyses: ${error}`);
    }
  }

  public async getCodeQLAlerts(owner: string, repo: string) {
    this.logger.logServiceCall("GitHubService", "getCodeQLAlerts", "started", {
      owner,
      repo,
    });

    if (!this.octokit) {
      const error = new Error("GitHub token not configured");
      this.logger.logServiceCall(
        "GitHubService",
        "getCodeQLAlerts",
        "failed",
        error
      );
      throw error;
    }

    try {
      this.logger.logGitHubAPI(
        `repos/${owner}/${repo}/code-scanning/alerts`,
        "request"
      );
      const response = await this.octokit.codeScanning.listAlertsForRepo({
        owner,
        repo,
        state: "open",
        per_page: 100,
      });

      // Filter for CodeQL alerts only
      const codeqlAlerts = response.data.filter(
        (alert: any) =>
          alert.tool &&
          (alert.tool.name === "CodeQL" || alert.tool.name.startsWith("CodeQL"))
      );

      this.logger.logServiceCall(
        "GitHubService",
        "getCodeQLAlerts",
        "completed",
        {
          totalAlerts: response.data.length,
          codeqlAlerts: codeqlAlerts.length,
        }
      );
      return codeqlAlerts;
    } catch (error) {
      this.logger.logServiceCall(
        "GitHubService",
        "getCodeQLAlerts",
        "failed",
        error
      );
      throw new Error(`Failed to get CodeQL alerts: ${error}`);
    }
  }

  public async getGitInfo(): Promise<{ owner: string; repo: string } | null> {
    this.logger.logServiceCall("GitHubService", "getGitInfo", "started");

    try {
      // First try to get info from VS Code Git extension
      const vscodeGitInfo = await this.getGitInfoFromVSCode();
      if (vscodeGitInfo) {
        this.logger.logServiceCall("GitHubService", "getGitInfo", "completed", {
          source: "vscode",
          ...vscodeGitInfo,
        });
        return vscodeGitInfo;
      }

      // Fallback to git CLI
      const gitCliInfo = await this.getGitInfoFromCLI();
      if (gitCliInfo) {
        this.logger.logServiceCall("GitHubService", "getGitInfo", "completed", {
          source: "cli",
          ...gitCliInfo,
        });
        return gitCliInfo;
      }

      this.logger.warn(
        "GitHubService",
        "Could not retrieve git information from VS Code extension or CLI"
      );
      return null;
    } catch (error) {
      this.logger.logServiceCall(
        "GitHubService",
        "getGitInfo",
        "failed",
        error
      );
      return null;
    }
  }

  private async getGitInfoFromVSCode(): Promise<{
    owner: string;
    repo: string;
  } | null> {
    try {
      const gitExtension = vscode.extensions.getExtension("vscode.git");
      if (!gitExtension) {
        this.logger.debug("GitHubService", "VS Code Git extension not found");
        return null;
      }

      if (!gitExtension.isActive) {
        await gitExtension.activate();
      }

      const git = gitExtension.exports.getAPI(1);
      if (!git || git.repositories.length === 0) {
        this.logger.debug(
          "GitHubService",
          "No git repositories found in VS Code"
        );
        return null;
      }

      const repository = git.repositories[0];
      if (!repository.state.remotes || repository.state.remotes.length === 0) {
        this.logger.debug(
          "GitHubService",
          "No git remotes found in VS Code repository"
        );
        return null;
      }

      // Look for origin remote first, then any remote
      let remote = repository.state.remotes.find(
        (r: any) => r.name === "origin"
      );
      if (!remote) {
        remote = repository.state.remotes[0];
      }

      const fetchUrl = remote.fetchUrl || remote.pushUrl;
      if (!fetchUrl) {
        this.logger.debug(
          "GitHubService",
          "No remote URL found in VS Code repository"
        );
        return null;
      }

      const gitInfo = this.parseGitRemoteUrl(fetchUrl);
      if (gitInfo) {
        this.logger.debug(
          "GitHubService",
          "Successfully parsed git info from VS Code",
          { url: fetchUrl, ...gitInfo }
        );
      }
      return gitInfo;
    } catch (error) {
      this.logger.debug(
        "GitHubService",
        "Failed to get git info from VS Code extension",
        error
      );
      return null;
    }
  }

  private async getGitInfoFromCLI(): Promise<{
    owner: string;
    repo: string;
  } | null> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.logger.debug(
          "GitHubService",
          "No workspace folders found for git CLI"
        );
        return null;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;

      // Import child_process and util for exec
      const { exec } = require("child_process");
      const { promisify } = require("util");
      const execAsync = promisify(exec);

      // Get the remote URL using git CLI
      const { stdout } = await execAsync("git remote get-url origin", {
        cwd: workspaceRoot,
        timeout: 5000,
      });

      const remoteUrl = stdout.trim();
      if (!remoteUrl) {
        this.logger.debug("GitHubService", "No git remote URL found via CLI");
        return null;
      }

      const gitInfo = this.parseGitRemoteUrl(remoteUrl);
      if (gitInfo) {
        this.logger.debug(
          "GitHubService",
          "Successfully parsed git info from CLI",
          { url: remoteUrl, ...gitInfo }
        );
      }
      return gitInfo;
    } catch (error) {
      this.logger.debug(
        "GitHubService",
        "Failed to get git info from CLI",
        error
      );
      return null;
    }
  }

  private parseGitRemoteUrl(
    url: string
  ): { owner: string; repo: string } | null {
    try {
      // Remove .git suffix if present
      const cleanUrl = url.replace(/\.git$/, "");

      // Handle different URL formats
      let match;

      // SSH format: git@github.com:owner/repo or git@enterprise.com:owner/repo
      match = cleanUrl.match(/git@([^:]+):([^/]+)\/(.+)$/);
      if (match) {
        return { owner: match[2], repo: match[3] };
      }

      // HTTPS format: https://github.com/owner/repo or https://enterprise.com/owner/repo
      match = cleanUrl.match(/https:\/\/([^/]+)\/([^/]+)\/(.+)$/);
      if (match) {
        return { owner: match[2], repo: match[3] };
      }

      // HTTP format: http://github.com/owner/repo or http://enterprise.com/owner/repo
      match = cleanUrl.match(/http:\/\/([^/]+)\/([^/]+)\/(.+)$/);
      if (match) {
        return { owner: match[2], repo: match[3] };
      }

      this.logger.debug("GitHubService", "Could not parse git remote URL", {
        url,
      });
      return null;
    } catch (error) {
      this.logger.debug("GitHubService", "Error parsing git remote URL", {
        url,
        error,
      });
      return null;
    }
  }

  private extractInstanceFromBaseUrl(baseUrl: string): string {
    try {
      // Extract the hostname from the base URL
      const url = new URL(baseUrl);
      let hostname = url.hostname;

      // Handle common GitHub instances
      if (hostname === "api.github.com") {
        return "github.com";
      }

      // For GitHub Enterprise Server, the API URL is typically:
      // https://your-github-instance.com/api/v3
      // We want to extract just the main domain
      if (hostname.includes("github")) {
        // Remove 'api.' prefix if present
        hostname = hostname.replace(/^api\./, "");
        return hostname;
      }

      return hostname;
    } catch (error) {
      this.logger.warn(
        "GitHubService",
        "Failed to parse base URL, using default",
        { baseUrl, error }
      );
      return "github.com";
    }
  }
}
