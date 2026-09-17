# Security Policy

## Threat model, stated plainly

pi-python exists to execute code written by a language model on your
machine. Arbitrary code execution is the **feature**, not a
vulnerability. The extension spawns a normal `python3` subprocess with
your user's privileges and pipes code into it. There is no sandbox, no
container, no seccomp filter, no import allowlist, and no filesystem
restriction.

A cell can therefore read your SSH keys, exfiltrate data over the
network, delete files, and spawn further processes. This is inherent to
what the tool does. Use it only where you would be comfortable running
the same code by hand.

The environment-variable filter in `kernel.ts` (`filterEnv`) strips
API-key-shaped variables from the subprocess environment. It exists to
reduce *accidental* credential leakage into a tool result that then goes
back to a model provider. It is pattern matching, it is best-effort, and
it is not a control against deliberately hostile code — anything that
reads a credential file bypasses it entirely.

## What counts as a reportable vulnerability

Because the above is by design, a report is in scope when the extension
does something a user could not reasonably expect, such as:

* Code executing when no `python` tool call was made, or after the kernel
  was supposed to be shut down.
* The kernel being spawned with a different interpreter than the one
  resolution rules and `/python-status` report.
* Credentials or namespace contents being written somewhere not
  documented (the extension deliberately persists nothing to disk).
* A crash or protocol confusion in the NDJSON framing that lets cell
  output forge control messages to the host.
* Privilege escalation beyond the invoking user.

Out of scope: "a cell can read `/etc/passwd`", "a cell can make network
requests", "the env filter can be bypassed by reading a file", and
similar restatements of the documented design.

## Reporting

Please report suspected vulnerabilities privately via GitHub's
[security advisory form](https://github.com/Luminger/pi-python/security/advisories/new)
rather than a public issue.

Include the pi version, the extension commit, your OS and Python version,
and a minimal reproduction. Expect an initial response within a couple of
weeks — this is a spare-time project, not a funded one.

## Supported versions

Only the current `main` branch receives fixes. There are no backports.
