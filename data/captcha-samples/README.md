# CAPTCHA Test Fixtures

This directory contains versioned CAPTCHA images and answer sheets used for OCR regression testing.

- Keep sample images and `answers.csv` files under version control.
- Do not commit `cookies.txt` or `login.html`; they are collection-session artifacts.
- Treat a round as training data after it has been used to tune OCR behavior.
- Validate tuned behavior on a newly collected, untouched holdout round before release.
- Never delete historical rounds as part of cleanup, packaging, or worktree operations.
