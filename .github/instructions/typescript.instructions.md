---
applyTo: '**/*.ts'
---

You are building a VSCode Extension that integrates with CodeQL to scan code for vulnerabilities.
The extension provides functionality to scan code for vulnerabilities using CodeQL.

All code must be written to support Linux, Macos, and Windows.
This includes path manipulation, command running, etc.

Always use the logging functionality provided by the extension's `logger` module for consistent logging across the extension.
Always log actions that modify the state of the extension, such as configuration changes, CLI path updates, or user interactions.

## Testing

Always write unit tests for new features or bug fixes using the testing framework already set up in the project.
Tests should be placed in the `tests` directory and follow the naming convention of the files they are testing.

## Documentation

Always add or update functions or inline comments to ensure the code is well-documented.

## Changelog

Update the `CHANGELOG.md` file with a new entry for this unknown version, following the existing format.

- Add a new entry for this version with the date and a brief description of changes
- Ensure the changelog entry is formatted correctly with markdown syntax
