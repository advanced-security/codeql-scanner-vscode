// Test script to verify language mapping behavior
const { CodeQLService } = require('./out/services/codeqlService');

// Mock GitHub service for testing
const mockGitHubService = {
    getRepositoryInfo: () => Promise.resolve({ owner: 'test', repo: 'test' })
};

// Create CodeQL service instance
const codeqlService = new CodeQLService(mockGitHubService);

// Test cases to verify the mapping
console.log('Testing language mapping...');

// Test 1: TypeScript should map to JavaScript
const typescriptLanguages = ['typescript', 'ts'];
const mappedTS = codeqlService.mapLanguagesToCodeQL(typescriptLanguages);
console.log('TypeScript languages:', typescriptLanguages, '-> Mapped to:', mappedTS);

// Test 2: Mixed languages including TypeScript
const mixedLanguages = ['javascript', 'typescript', 'python', 'java'];
const mappedMixed = codeqlService.mapLanguagesToCodeQL(mixedLanguages);
console.log('Mixed languages:', mixedLanguages, '-> Mapped to:', mappedMixed);

// Test 3: Direct JavaScript should still work
const jsLanguages = ['javascript', 'js'];
const mappedJS = codeqlService.mapLanguagesToCodeQL(jsLanguages);
console.log('JavaScript languages:', jsLanguages, '-> Mapped to:', mappedJS);

// Test 4: Check all supported languages
const supportedLanguages = codeqlService.getLanguages();
console.log('All supported CodeQL languages:', supportedLanguages);