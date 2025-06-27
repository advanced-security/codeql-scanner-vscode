// Simple test of the mapping logic without dependencies
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

// Test the mapping logic
console.log('Testing language mapping logic...');

console.log('Test 1 - TypeScript should map to JavaScript:');
const test1 = mapLanguagesToCodeQL(['TypeScript']);
console.log('Input: ["TypeScript"] -> Output:', test1);
console.log('Expected: ["javascript"], Actual:', test1);
console.log('Pass:', JSON.stringify(test1) === '["javascript"]');

console.log('\nTest 2 - typescript (lowercase) should map to JavaScript:');
const test2 = mapLanguagesToCodeQL(['typescript']);
console.log('Input: ["typescript"] -> Output:', test2);
console.log('Expected: ["javascript"], Actual:', test2);
console.log('Pass:', JSON.stringify(test2) === '["javascript"]');

console.log('\nTest 3 - Mixed languages with TypeScript:');
const test3 = mapLanguagesToCodeQL(['JavaScript', 'TypeScript', 'Python']);
console.log('Input: ["JavaScript", "TypeScript", "Python"] -> Output:', test3);
console.log('Expected: ["javascript", "python"], Actual:', test3);
console.log('Pass:', JSON.stringify(test3) === '["javascript","python"]');

console.log('\nTest 4 - ts extension should map to JavaScript:');
const test4 = mapLanguagesToCodeQL(['ts']);
console.log('Input: ["ts"] -> Output:', test4);
console.log('Expected: ["javascript"], Actual:', test4);
console.log('Pass:', JSON.stringify(test4) === '["javascript"]');