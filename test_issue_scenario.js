// Test to reproduce the language mapping issue
// This simulates the flow in runLocalScan()

const languages = {
  javascript: ["javascript", "typescript", "js", "ts", "jsx", "tsx"],
  python: ["python", "py"],
  java: ["java"],
  csharp: ["csharp", "c#", "cs"],
  cpp: ["cpp", "c++", "c", "cc", "cxx"],
  go: ["go", "golang"],
  ruby: ["ruby", "rb"],
  swift: ["swift"],
  kotlin: ["kotlin", "kt"],
  scala: ["scala"],
};

function mapLanguagesToCodeQL(inputLanguages) {
  const results = [];
  const addedLanguages = new Set();

  for (const language of inputLanguages) {
    const lang = language.toLowerCase();

    // Direct match with CodeQL language
    if (languages[lang] && !addedLanguages.has(lang)) {
      results.push(lang);
      addedLanguages.add(lang);
      continue;
    }

    // Check if it's an alias for a CodeQL language
    for (const [codeqlLang, aliases] of Object.entries(languages)) {
      if (aliases.includes(lang) && !addedLanguages.has(codeqlLang)) {
        results.push(codeqlLang);
        addedLanguages.add(codeqlLang);
        break;
      }
    }
  }

  return [...new Set(results)]; // Remove any duplicates just in case
}

// Simulate the problematic scenario
console.log('Simulating the issue scenario...');

// Simulate GitHub API returning TypeScript as a language
const githubLanguages = ["TypeScript", "JavaScript"];
console.log('GitHub languages detected:', githubLanguages);

// Simulate the mapping that should happen
const mappedLanguages = mapLanguagesToCodeQL(githubLanguages);
console.log('Mapped languages:', mappedLanguages);

// Expected result: should be ["javascript"] (only one entry since both TypeScript and JavaScript map to javascript)
console.log('Expected: ["javascript"]');
console.log('Test passes:', JSON.stringify(mappedLanguages) === '["javascript"]');

// Check if there's an issue with duplicate handling
console.log('\nTesting duplicate handling...');
const testDuplicates = mapLanguagesToCodeQL(["javascript", "typescript", "js", "ts"]);
console.log('Input: ["javascript", "typescript", "js", "ts"]');
console.log('Output:', testDuplicates);
console.log('Expected: ["javascript"]');
console.log('Test passes:', JSON.stringify(testDuplicates) === '["javascript"]');

// Test with only TypeScript
console.log('\nTesting TypeScript only...');
const testTypescriptOnly = mapLanguagesToCodeQL(["TypeScript"]);
console.log('Input: ["TypeScript"]');
console.log('Output:', testTypescriptOnly);
console.log('Expected: ["javascript"]');
console.log('Test passes:', JSON.stringify(testTypescriptOnly) === '["javascript"]');