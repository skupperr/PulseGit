import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { buildGitPushCommand, classifyGitError } from '../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('buildGitPushCommand uses an upstream push for initial remote sync', () => {
		assert.strictEqual(buildGitPushCommand(), 'git push --set-upstream origin HEAD');
	});

	test('buildGitPushCommand uses the current branch name when a repo is available', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsegit-test-'));

		try {
			execSync('git init', { cwd: tempDir, stdio: 'ignore' });
			execSync('git checkout -b feature/test', { cwd: tempDir, stdio: 'ignore' });

			assert.strictEqual(buildGitPushCommand(tempDir), 'git push --set-upstream origin feature/test');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('classifyGitError explains missing Git identity', () => {
		const message = classifyGitError('Author identity unknown\n*** Please tell me who you are.');
		assert.match(message, /user\.name|user\.email/i);
	});
});
