# Security Policy

## Supported versions

The project is pre-1.0, and only the latest release receives security fixes.

| Version            | Supported |
| ------------------ | --------- |
| Latest 0.x release | ✅        |
| Older releases     | ❌        |

## Reporting a vulnerability

**Do not report security vulnerabilities through public issues, Discussions or pull requests.**

Report them through GitHub [private vulnerability reporting](https://github.com/nomofly/open-miniprogram-runtime/security/advisories/new). If you cannot use it, email [hi@nomofly.com](mailto:hi@nomofly.com) with `[SECURITY]` in the subject.

Please include as much of the following as you can:

- The type of vulnerability and its impact (for example, Mini Program code escaping the sandbox, running arbitrary code on the host, or reading host files)
- Affected versions or commits
- Steps to reproduce or a proof of concept
- A suggested fix, if you have one

## What to expect

- We acknowledge your report within **3 business days**.
- We send an initial assessment within **10 business days**.
- After a fix is released, we disclose the issue through a GitHub Security Advisory and, with your permission, credit you.

Please keep the details private until the fix is released and disclosed. Thank you for helping keep the project and its users safe.

## Security boundary

The simulator runs third-party Mini Program code. The isolation between the logic layer and the host, and the access control that `wx.*` APIs apply to host capabilities (file system, network, clipboard and so on), are this project's security boundary. Anything that breaks out of them should be reported as a vulnerability.
