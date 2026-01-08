# CodePulse Privacy Policy

**Effective Date:** January 8, 2026

CodePulse is designed to track coding activity **locally**. Your privacy and data ownership are central to its design.  

---

## Data Collection

- CodePulse **does not collect or transmit any personal data** to external servers.
- All activity tracking occurs **on your machine**.
- Only the snapshots you explicitly push are sent to a Git repository you control.

---

## Data Stored

- File paths of files you edit
- Programming languages used
- Number of lines changed
- Timestamps for each snapshot

All data is stored locally in your extension storage folder and optionally in the Git repository you configure.

---

## Data Sharing

- CodePulse **never shares your data externally**.
- Snapshots are pushed **only** to a repository URL you explicitly configure in the settings.
- If you configure a repository you do not have access to, pushes will fail, and CodePulse will notify you with an error.

---

## Offline Mode

- Snapshots are stored locally if Git push fails due to network or permission issues.
- CodePulse automatically retries syncing when connectivity is restored.

---

## Security

- Data in local storage is only accessible by the user.
- Git pushes are protected by your existing Git authentication.

---

## Summary

CodePulse ensures:

- Full local ownership of your coding activity
- No tracking of users or sending of data to third-party services
- Transparency and control over where your snapshots are stored
