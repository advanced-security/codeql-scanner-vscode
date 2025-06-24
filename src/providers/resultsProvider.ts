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
            // Root level - group by language
            const groups = this.groupByLanguage(this.results);
            return Promise.resolve(
                Object.entries(groups).map(([language, results]) => 
                    new ResultItem(
                        `${language.toUpperCase()} (${results.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'language',
                        language,
                        results
                    )
                )
            );
        } else if (element.type === 'language') {
            // Second level - group by severity within language
            const severityGroups = this.groupBySeverity(element.results!);
            const sortedSeverities = this.sortSeverityGroups(severityGroups);
            return Promise.resolve(
                sortedSeverities.map(([severity, results]) => 
                    new ResultItem(
                        `${this.getSeverityDisplayName(severity)} (${results.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'severity',
                        element.language,
                        results,
                        undefined,
                        severity
                    )
                )
            );
        } else if (element.type === 'severity') {
            // Third level - individual results
            return Promise.resolve(
                element.results!.map(result => 
                    new ResultItem(
                        `${result.ruleId}: ${result.message}`,
                        vscode.TreeItemCollapsibleState.None,
                        'result',
                        element.language,
                        undefined,
                        result
                    )
                )
            );
        }

        return Promise.resolve([]);
    }

    private groupByLanguage(results: ScanResult[]): { [language: string]: ScanResult[] } {
        return results.reduce((groups, result) => {
            const language = result.language || 'unknown';
            if (!groups[language]) {
                groups[language] = [];
            }
            groups[language].push(result);
            return groups;
        }, {} as { [language: string]: ScanResult[] });
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

    private getSeverityDisplayName(severity: string): string {
        const severityMap: { [key: string]: string } = {
            'critical': '🔥 Critical',
            'high': '⚠️ High',
            'error': '⚠️ High',
            'medium': '⚡ Medium',
            'warning': '⚡ Medium',
            'low': 'ℹ️ Low',
            'info': 'ℹ️ Low',
            'unknown': '❓ Unknown'
        };
        return severityMap[severity] || `❓ ${severity.charAt(0).toUpperCase() + severity.slice(1)}`;
    }

    private sortSeverityGroups(severityGroups: { [severity: string]: ScanResult[] }): [string, ScanResult[]][] {
        const severityOrder = ['critical', 'high', 'error', 'medium', 'warning', 'low', 'info', 'unknown'];
        
        return Object.entries(severityGroups).sort(([a], [b]) => {
            const aIndex = severityOrder.indexOf(a);
            const bIndex = severityOrder.indexOf(b);
            
            // If severity not found in order, put it at the end
            if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            
            return aIndex - bIndex;
        });
    }
}

export class ResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'language' | 'severity' | 'result',
        public readonly language?: string,
        public readonly results?: ScanResult[],
        public readonly result?: ScanResult,
        public readonly severity?: string
    ) {
        super(label, collapsibleState);

        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
        this.command = this.getCommand();
        this.contextValue = type;
    }

    private getTooltip(): string {
        if (this.type === 'language') {
            return `${this.results?.length || 0} ${this.language} language issues`;
        } else if (this.type === 'severity') {
            return `${this.results?.length || 0} ${this.severity} severity issues in ${this.language}`;
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
        if (this.type === 'language') {
            switch (this.language) {
                case 'javascript':
                    return new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('symbolIcon.classForeground'));
                case 'python':
                    return new vscode.ThemeIcon('symbol-function', new vscode.ThemeColor('symbolIcon.functionForeground'));
                case 'java':
                    return new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('symbolIcon.interfaceForeground'));
                case 'csharp':
                    return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('symbolIcon.namespaceForeground'));
                case 'cpp':
                    return new vscode.ThemeIcon('symbol-struct', new vscode.ThemeColor('symbolIcon.structForeground'));
                default:
                    return new vscode.ThemeIcon('file-code');
            }
        } else if (this.type === 'severity') {
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
