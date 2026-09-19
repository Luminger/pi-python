# Security Policy

## Threat model

Installing pi-python gives the active LLM arbitrary code execution as the user
running pi. The model supplies and invokes the code without per-cell approval.
There is no sandbox, and the Python process inherits pi's environment unchanged.
The model can do anything that user can do.

Model mistakes, prompt injection, and malicious instructions all operate within
that same authority. pi-python cannot make arbitrary model-driven execution safe
from inside the process being controlled.

If this authority is too broad, restrict it outside pi-python: run pi under a
dedicated account, container, VM, sandbox, or other OS-level boundary.

## What counts as a vulnerability

Arbitrary execution through an accepted `python` tool call is the intended
capability. Reports are in scope when pi-python exceeds or misrepresents that
boundary—for example by executing without a corresponding tool call, crossing
session boundaries, using a different interpreter than reported, persisting or
transmitting cell data on its own, accepting forged protocol messages, or
escalating beyond the OS identity running pi.

The fact that the model can exercise the authority of the user running pi,
including after prompt injection, is not a bypass in pi-python; it is the
documented security model.

## Reporting

Please report suspected vulnerabilities privately through GitHub's
[security advisory form](https://github.com/Luminger/pi-python/security/advisories/new)
rather than a public issue.

Include the pi version, pi-python version or commit, OS and Python version, and a
minimal reproduction. Expect an initial response within a couple of weeks; this
is a spare-time project, not a funded service.

## Supported versions

Only the current `main` branch receives fixes. There are no backports.
