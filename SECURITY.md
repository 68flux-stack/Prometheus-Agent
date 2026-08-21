# Security Policy

## Supported versions

Security fixes are applied to the latest published release of `prometheus-agent` and the
latest desktop build. Older versions are not patched.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/68flux-stack/Prometheus-Agent/security/advisories/new).
Do not open a public issue for a security problem.

Include the version, your platform, reproduction steps, and the impact you observed. You
should get an acknowledgement within seven days.

## Scope and threat model

Prometheus runs model-generated Python, shell commands, extensions, skills, and project
instructions **with your own user permissions**. Worker and kernel processes exist for
lifecycle isolation and crash recovery — they are **not** a security sandbox.

The following are therefore expected behavior, not vulnerabilities:

- A prompt, skill, extension, or project instruction causing file or command execution in
  the working directory.
- A resource package installed with `prometheus package install` running arbitrary code.
- The agent reading credentials that your own user account can already read.

Run untrusted repositories, instructions, or code inside an external sandbox.

In-scope reports include credential leakage into logs, transcripts, or telemetry; privilege
escalation beyond the invoking user; and remote code execution triggered without the user
running the agent against untrusted input.
