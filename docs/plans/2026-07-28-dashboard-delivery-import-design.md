# Dashboard-managed delivery import design

## Goal

Let a lead connect GitHub and Jira, import a dated delivery baseline, and review
previous runs without using a terminal or exposing credentials.

## User flow

The DORA empty state opens a Delivery Data panel. The panel contains:

1. Connection fields for a GitHub organization and read-only token, Jira URL,
   email, token, and project keys.
2. A connection test that validates both services before saving.
3. Repository scope, anonymization, and a baseline start date.
4. An import action with live status and a persistent history of dated runs,
   counts, duration, and understandable errors.

After a successful import, the panel closes or remains available from the DORA
strip and the dashboard refreshes the delivery metrics automatically.

## Security and persistence

Credentials are encrypted with AES-256-GCM before they are written to the
Docker data volume. The encryption key is derived from
`CREDENTIAL_ENCRYPTION_KEY`, supplied to the server container. API responses,
run history, progress messages, and logs never contain tokens.

Non-secret configuration and encrypted credentials are stored separately from
the generated baseline artifacts. Replacing or deleting a connection is
supported. Only one import may run at a time.

## Architecture

The server owns connection testing, encrypted settings, job lifecycle, and
history. It executes the existing read-only extractor as a child process and
streams a sanitized progress summary into job state. The Docker server image
includes the analytics extractor, and its output remains on the persistent data
volume.

The React panel polls the job endpoint only while an import is active. The
existing DORA component listens for a local refresh event after completion.

## Failure handling

Validation errors stay next to the form. Authentication, network, and extractor
errors become sanitized run-history entries. A failed import never replaces the
latest successful baseline. Credentials are never returned after saving.

## Verification

Add regression coverage for encryption, redaction, settings persistence, and
job state. Run all tests and builds, rebuild Docker, exercise connection-error
and successful fixture paths, and verify the responsive UI.
