import * as vscode from 'vscode';
import { ScanResult } from '../services/codeqlService';

export class ResultsProvider implements vscode.TreeDataProvider<ResultItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ResultItem | undefined | null | void> = new vscode.EventEmitter<ResultItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ResultItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private results: ScanResult[] = [];

    constructor() {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setResults(results: ScanResult[]): void {
        this.results = results;
        this.refresh();
    }

    getResults(): ScanResult[] {
        return this.results;
    }

    getTreeItem(element: ResultItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ResultItem): Thenable<ResultItem[]> {
        if (!element) {
            // Root level - group by severity
            const groups = this.groupBySeverity(this.results);
            return Promise.resolve(
                Object.entries(groups).map(([severity, results]) => 
                    new ResultItem(
                        `${severity.toUpperCase()} (${results.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'severity',
                        severity,
                        results
                    )
                )
            );
        } else if (element.type === 'severity') {
            // Second level - individual results
            return Promise.resolve(
                element.results!.map(result => 
                    new ResultItem(
                        `${result.ruleId}: ${result.message}`,
                        vscode.TreeItemCollapsibleState.None,
                        'result',
                        undefined,
                        undefined,
                        result
                    )
                )
            );
        }

        return Promise.resolve([]);
    }

    private groupBySeverity(results: ScanResult[]): { [severity: string]: ScanResult[] } {
        return results.reduce((groups, result) => {
            const severity = result.severity || 'unknown';
            if (!groups[severity]) {
                groups[severity] = [];
            }
            groups[severity].push(result);
            return groups;
        }, {} as { [severity: string]: ScanResult[] });
    }
}

export class ResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'severity' | 'result',
        public readonly severity?: string,
        public readonly results?: ScanResult[],
        public readonly result?: ScanResult
    ) {
        super(label, collapsibleState);

        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
        this.command = this.getCommand();
        this.contextValue = type;
    }

    private getTooltip(): string {
        if (this.type === 'severity') {
            return `${this.results?.length || 0} ${this.severity} severity issues`;
        } else if (this.result) {
            return `${this.result.ruleId}: ${this.result.message}\\nFile: ${this.result.location.file}\\nLine: ${this.result.location.startLine}`;
        }
        return this.label;
    }

    private getDescription(): string {
        if (this.type === 'result' && this.result) {
            return `${this.result.location.file}:${this.result.location.startLine}`;
        }
        return '';
    }

    private getIcon(): vscode.ThemeIcon {
        if (this.type === 'severity') {
            switch (this.severity) {
                case 'critical':
                    return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                case 'error':
                case 'high':
                    return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                case 'warning':
                case 'medium':
                    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('warningForeground'));
                case 'info':
                case 'low':
                    return new vscode.ThemeIcon('info', new vscode.ThemeColor('infoForeground'));
                default:
                    return new vscode.ThemeIcon('circle-outline');
            }
        } else if (this.type === 'result') {
            switch (this.result?.severity) {
                case 'critical':
                    return new vscode.ThemeIcon('bug', new vscode.ThemeColor('errorForeground'));
                case 'error':
                case 'high':
                    return new vscode.ThemeIcon('bug', new vscode.ThemeColor('errorForeground'));
                case 'warning':
                case 'medium':
                    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('warningForeground'));
                case 'info':
                case 'low':
                    return new vscode.ThemeIcon('info', new vscode.ThemeColor('infoForeground'));
                default:
                    return new vscode.ThemeIcon('circle-filled');
            }
        }
        return new vscode.ThemeIcon('circle-outline');
    }

    private getCommand(): vscode.Command | undefined {
        if (this.type === 'result' && this.result) {
            return {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    vscode.Uri.file(this.result.location.file),
                    {
                        selection: new vscode.Range(
                            this.result.location.startLine - 1,
                            this.result.location.startColumn - 1,
                            this.result.location.endLine - 1,
                            this.result.location.endColumn - 1
                        )
                    }
                ]
            };
        }
        return undefined;
    }
}
