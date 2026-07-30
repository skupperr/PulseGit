import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);


type ActivityBuffer = {
	files: Set<string>;
	languages: Set<string>;
	linesChanged: number;
};

let activityBuffer: ActivityBuffer = {
	files: new Set(),
	languages: new Set(),
	linesChanged: 0
};

let gitInProgress = false;
let pushPending = false;
let successNotifiedForBatch = false;
let repoGeneration = 0;



// const FLUSH_INTERVAL_MS = 30 * 10000; // dev mode

function getConfig() {
	return vscode.workspace.getConfiguration('pulsegit');
}


function getStoragePath(context: vscode.ExtensionContext) {
	return context.globalStorageUri.fsPath;
}

function getSnapshotsPath(context: vscode.ExtensionContext) {
	return path.join(getStoragePath(context), 'snapshots');
}

function getRepoPath(context: vscode.ExtensionContext) {
	return path.join(getStoragePath(context), 'activity-repo');
}




function ensureRepoCloned(context: vscode.ExtensionContext): boolean {

	const repoUrl = getConfig()
		.get<string>('repoUrl', '')
		.trim();

	const repoPath = getRepoPath(context);


	if (!repoUrl) {
		return false;
	}


	if (repoIsReady(repoPath)) {
		return true;
	}


	if (fs.existsSync(repoPath)) {

		notifyWarn(
			'PulseGit: Removing invalid local repository...'
		);

		fs.rmSync(repoPath, {
			recursive: true,
			force: true
		});
	}


	fs.mkdirSync(
		path.dirname(repoPath),
		{ recursive: true }
	);


	try {

		execSync(
			`git clone "${repoUrl}" "${repoPath}"`,
			{
				stdio: 'pipe'
			}
		);

		return true;

	}
	catch (e: any) {

		const msg =
			e.stderr?.toString()
			||
			e.message;

		notifyWarn(
			`PulseGit: Failed to clone repo — ${classifyGitError(msg)}`
		);


		return false;
	}
}



// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('pulsegit.snapshotIntervalMinutes')) {
			clearInterval(interval);
			interval = setInterval(
				() => flushActivity(context),
				getSnapshotIntervalMs()
			);
		}


		if (e.affectsConfiguration('pulsegit.repoUrl')) {
			repoGeneration++;

			const repoPath = getRepoPath(context);

			// First time setup
			if (!repoIsReady(repoPath)) {
				ensureRepoCloned(context);
				return;
			}

			// Existing repo → just update origin
			updateRemote(context);
		}


	});


	function getSnapshotIntervalMs() {
		const minutes = getConfig().get<number>(
			'snapshotIntervalMinutes',
			30
		);
		return Math.max(minutes, 5) * 60 * 1000;
	}

	try {
		const gitVersion = execSync('git --version').toString();
		notifyInfo(gitVersion);
	} catch (e: any) {
		vscode.window.showErrorMessage(
			`Git not available to PulseGit: ${e.message}`
		);
	}


	notifyInfo('PulseGit is running');

	const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
		if (!getConfig().get<boolean>('enabled')) {
			return;
		}

		const doc = event.document;

		if (doc.uri.scheme !== 'file') {
			return;
		}

		activityBuffer.files.add(doc.uri.fsPath);
		activityBuffer.languages.add(doc.languageId);

		for (const change of event.contentChanges) {
			const newLines = change.text.split('\n').length - 1;
			const oldLines = change.range.end.line - change.range.start.line;
			activityBuffer.linesChanged += Math.abs(newLines - oldLines);
		}

		vscode.window.setStatusBarMessage(
			`PulseGit: ${activityBuffer.files.size} files · ${activityBuffer.linesChanged} LOC`,
			1500
		);
	});

	ensureRepoCloned(context);

	const repoUrl = getConfig().get<string>('repoUrl', '').trim();

	if (!repoUrl && getConfig().get<boolean>('enableGitSync')) {
		notifyWarn(
			'PulseGit: Set a Git repository URL to enable syncing.'
		);
	}

	if (repoIsReady(getRepoPath(context)) && repoHasCommits(getRepoPath(context))) {
		void tryPush(getRepoPath(context));
	}


	let interval = setInterval(
		() => flushActivity(context),
		getSnapshotIntervalMs()
	);


	context.subscriptions.push({
		dispose: () => clearInterval(interval)
	});

	const pushRetryInterval = setInterval(() => {
		if (!pushPending || gitInProgress) {
			return;
		}
		if (!repoIsReady(getRepoPath(context))) {
			return;
		};
		void tryPush(getRepoPath(context));
	}, 60 * 1000);


	context.subscriptions.push({
		dispose: () => clearInterval(pushRetryInterval)
	});



	context.subscriptions.push(disposable);

	const forceSnapshotCommand = vscode.commands.registerCommand(
		'pulsegit.forceSnapshot',
		() => {
			flushActivity(context, true);
		}
	);

	context.subscriptions.push(forceSnapshotCommand);

	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.text = '$(pulse) PulseGit';
	statusBarItem.command = 'pulsegit.forceSnapshot';
	statusBarItem.tooltip = 'Force snapshot and sync activity';
	statusBarItem.show();

	context.subscriptions.push(statusBarItem);


}


export function deactivate() { }


function flushActivity(context: vscode.ExtensionContext, manual = false) {

	if (!getConfig().get<boolean>('enabled')) {
		if (manual) {
			notifyInfo(
				'PulseGit tracking is disabled. Enable it in Settings to record activity.'
			);
		}
		return;
	}



	if (
		activityBuffer.files.size === 0 &&
		activityBuffer.linesChanged === 0
	) {
		if (manual) {
			notifyInfo('PulseGit: No activity to snapshot');
		}
		return;
	}

	const now = new Date();

	const snapshot = {
		timestamp: now.toISOString(),
		filesTouched: activityBuffer.files.size,
		languages: Array.from(activityBuffer.languages),
		linesChanged: activityBuffer.linesChanged
	};

	// const baseDir = path.join(getRepoPath(context), 'activity');
	const baseDir = path.join(getSnapshotsPath(context), 'activity');

	const dirPath = path.join(
		baseDir,
		now.getFullYear().toString(),
		String(now.getMonth() + 1).padStart(2, '0'),
		String(now.getDate()).padStart(2, '0')
	);

	fs.mkdirSync(dirPath, { recursive: true });

	const fileName = `${String(now.getHours()).padStart(2, '0')}-${String(
		now.getMinutes()
	).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.json`;


	const filePath = path.join(dirPath, fileName);

	fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));

	vscode.window.setStatusBarMessage(
		`PulseGit snapshot written`,
		3000
	);

	console.log("Dir: ", baseDir);
	// Reset buffer
	activityBuffer = {
		files: new Set(),
		languages: new Set(),
		linesChanged: 0
	};

	if (
		getConfig().get<boolean>('enableGitSync') &&
		getConfig().get<string>('repoUrl')?.trim() &&
		repoIsReady(getRepoPath(context))
	) {
		void commitAndPush(getRepoPath(context), context);
	}


}



async function commitAndPush(repoPath: string, context: any) {
	if (gitInProgress) { return; }
	gitInProgress = true;

	try {
		// Sync first so the status check sees the new files
		syncSnapshotsToRepo(context);

		const { stdout } = await execAsync('git status --porcelain', { cwd: repoPath });
		if (!stdout.trim()) { return; }

		try {
			await execAsync('git pull --rebase', {
				cwd: repoPath
			});
		} catch {
			// Ignore if remote is empty
		}

		await execAsync('git add .', { cwd: repoPath });
		await execAsync('git commit -m "activity: coding snapshot"', { cwd: repoPath });

		successNotifiedForBatch = false;
		await tryPush(repoPath);
	} catch (err: any) {
		const msg = getGitErrorText(err);
		notifyWarn(classifyGitError(msg));
		pushPending = false;
	} finally {
		gitInProgress = false;
	}
}



export function buildGitPushCommand(repoPath?: string): string {
	if (repoPath) {
		try {
			const branch = execSync('git branch --show-current', {
				cwd: repoPath,
				stdio: ['ignore', 'pipe', 'ignore']
			}).toString().trim();

			if (branch) {
				return `git push --set-upstream origin ${branch}`;
			}
		} catch {
			// Fall back to HEAD if branch detection fails.
		}
	}

	return 'git push --set-upstream origin HEAD';
}

async function tryPush(repoPath: string, generation = repoGeneration) {
	if (generation !== repoGeneration) { return; };

	const commands = ['git push', buildGitPushCommand(repoPath)];
	let lastUserMessage = '';

	for (const command of commands) {
		try {
			await execAsync(command, { cwd: repoPath });

			if (!successNotifiedForBatch) {
				notifyInfo('PulseGit synced to GitHub');
				successNotifiedForBatch = true;
			}

			pushPending = false;
			return;
		}
		catch (err: any) {
			const msg = getGitErrorText(err);
			lastUserMessage = classifyGitError(msg);

			const lowerMsg = msg.toLowerCase();
			const shouldRetryWithUpstream =
				command === 'git push' &&
				(
					lowerMsg.includes('no upstream branch') ||
					lowerMsg.includes('no configured push destination') ||
					lowerMsg.includes('set up to track')
				);

			if (!shouldRetryWithUpstream) {
				notifyWarn(lastUserMessage);
				pushPending = lastUserMessage.includes('offline');
				return;
			}
		}
	}

	notifyWarn(lastUserMessage || 'PulseGit push failed due to an unknown Git error.');
	pushPending = lastUserMessage.includes('offline');
}


export function getGitErrorText(err: any): string {
	if (typeof err === 'string') {
		return err;
	}

	const parts: string[] = [];

	if (err?.stdout) {
		parts.push(err.stdout.toString());
	}

	if (err?.stderr) {
		parts.push(err.stderr.toString());
	}

	if (err?.message) {
		parts.push(err.message);
	}

	return parts.filter(Boolean).join('\n').trim();
}

export function classifyGitError(message: string): string {
	const msg = message.toLowerCase();
	const trimmed = message.trim();

	if (msg.includes('author identity unknown') || msg.includes('please tell me who you are') || msg.includes('unable to auto-detect email address')) {
		return 'Git is missing your user.name/user.email settings. Configure them locally and try again.';
	}

	if (msg.includes('could not read username') || msg.includes('authentication failed') || msg.includes('terminal prompts disabled') || msg.includes('support for password authentication was removed')) {
		return 'Git authentication failed. Check your remote credentials or PAT and try again.';
	}

	if (msg.includes('repository not found')) {
		return 'The configured repository does not exist or the URL is incorrect.';
	}

	if (msg.includes('access denied') || msg.includes('permission')) {
		return 'You do not have permission to push to this repository.';
	}

	if (msg.includes('not a git repository')) {
		return 'The configured repository is invalid or was not cloned correctly.';
	}

	if (msg.includes('could not resolve host') || msg.includes('network')) {
		return 'PulseGit is offline. Changes will sync automatically.';
	}

	if (msg.includes('no upstream branch') || msg.includes('no configured push destination')) {
		return 'PulseGit could not push because the branch has no upstream remote. The next sync will retry with the correct remote tracking setup.';
	}

	if (trimmed) {
		return `PulseGit push failed: ${trimmed}`;
	}

	return 'PulseGit push failed due to an unknown Git error.';
}




function notifyInfo(message: string) {
	if (getConfig().get<boolean>('enableNotifications')) {
		vscode.window.showInformationMessage(message);
	}
}

function notifyWarn(message: string) {
	if (getConfig().get<boolean>('enableNotifications')) {
		vscode.window.showWarningMessage(message);
	}
}

function repoIsReady(repoPath: string): boolean {
	if (!fs.existsSync(path.join(repoPath, '.git'))) {
		return false;
	}
	try {
		execSync('git rev-parse --is-inside-work-tree', {
			cwd: repoPath,
			stdio: 'pipe'
		});
		return true;
	} catch {
		return false;
	}
}

function updateRemote(context: vscode.ExtensionContext): boolean {
	const repoPath = getRepoPath(context);
	const repoUrl = getConfig().get<string>('repoUrl', '').trim();

	if (!repoUrl) {
		return false;
	}

	try {
		execSync(
			`git remote set-url origin "${repoUrl}"`,
			{
				cwd: repoPath,
				stdio: 'pipe'
			}
		);

		notifyInfo('PulseGit repository updated.');
		return true;
	} catch (e: any) {
		const msg = e.stderr?.toString() || e.message;
		notifyWarn(classifyGitError(msg));
		return false;
	}
}

function syncSnapshotsToRepo(context: vscode.ExtensionContext) {
	const snapshots = path.join(getSnapshotsPath(context), 'activity');
	const repoActivity = path.join(getRepoPath(context), 'activity');

	if (!fs.existsSync(snapshots)) {
		return;
	}

	fs.mkdirSync(repoActivity, { recursive: true });

	fs.cpSync(snapshots, repoActivity, {
		recursive: true,
		force: true
	});
}

function repoHasCommits(repoPath: string): boolean {
	try {
		execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' });
		return true;
	} catch {
		return false;   // unborn branch — no commits yet
	}
}
