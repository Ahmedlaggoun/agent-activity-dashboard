# Metric legends and delivery baseline design

## Goal

Make every compact number on the live board understandable without requiring
users to know the dashboard implementation or AI-provider terminology.

## Design

Add a persistent metric guide above the board. It explains active turn time,
session tokens, estimated session cost, prompt count, and last activity. Each
item uses a distinct semantic color that is repeated on session cards and in
the session detail view. Native tooltips and accessible labels retain the full
meaning when space is constrained.

Replace the missing-DORA developer instruction with a user-facing empty state.
It explains that DORA measures delivery speed and stability and that cost per
merged PR estimates AI spend per delivered pull request. The interface will
state that the GitHub and Jira baseline is not connected, without exposing a
repository command.

## Alternatives considered

- Tooltips only: rejected because they are hidden on touch devices and are not
  discoverable.
- Full labels inside every session card: rejected because repeated text would
  make the live board harder to scan.

## Verification

Run the existing tests and production build, rebuild the local Docker stack on
port 18418, and verify the board visually at desktop and narrow widths.
