# Zoid Bank Sumi-Ink design rationale

## Global Sumi-Ink Contract

This project consumes Sumi-Ink Command System v0.1.0.

The canonical source is [the global Sumi-Ink DESIGN.md](../Sumi-Ink/DESIGN.md).

The canonical machine-readable values are in [tokens.json](../Sumi-Ink/tokens.json).

This file defines Zoid Bank product language, workflow patterns, and approved local decisions on top of the global system.

Zoid Bank must document any intentional deviation from the global component and token contract here.

Standard dropdown triggers use a 42px minimum height to align with Zoid Bank text and date fields.

Compact dropdown triggers and menu options retain the canonical 34px minimum height.

## Source system

Zoid Bank now adapts the Master Lance Sumi-Ink Command System for a private finance ledger.

The global source is the Sumi-Ink Command System documented in the canonical repository.

Zoid Bank keeps its own product language and data boundaries while adopting the shared ink, paper, rule, seal, editorial, and command-index grammar.

## Product question

How can a private, local-first finance companion make daily spending understandable without making the user feel watched or forcing them to inspect raw messages constantly?

The answer is a quiet signal ledger where money movements arrive as evidence, age visibly, and remain separate until the user makes a decision.

## Visual direction

White paper carries the workspace.

Near-black ink defines architecture, selected routes, evidence frames, and primary actions.

Pale rules organize dense financial evidence without turning every number into a floating card.

Red seal marks freshness, review, focus, approval, and destructive consequence.

Editorial serif typography makes the tracker feel authored and deliberate rather than like a generic SaaS admin template.

Square controls and zero-radius panels keep the interface exact and operational.

The redesign avoids gradients, glass effects, rounded pills, saturated category palettes, decorative charts, and status communicated by color alone.

## Information architecture

The identity rail establishes Zoid Bank as a local command surface.

The command index keeps Overview, Transactions, Analytics, Cash Flow, Review Queue, and Recurring visible as primary routes.

Settings is a separate workspace destination because the privacy boundary is part of the product experience.

Every route carries a command code so the current screen can be identified at a glance.

Overview answers what changed.

Transactions answers what was recorded and where each record came from.

Analytics answers what shape the approved debit sample takes.

Cash Flow answers what moved and what remains unavailable from the current source.

Review Queue answers what needs a human decision before it enters totals.

Recurring answers what repeats without presenting an inference as a promise.

Settings answers what is in scope, where it lives, and how uncertainty is held.

## Component grammar

Primary buttons use ink fills and paper text.

Quiet buttons use paper surfaces and written ink rules.

Review and attention actions use the red seal accent.

Cards are ruled paper sheets with one-pixel structural borders and no shadows.

Tables use semantic rows, strong column headers, and source-visible state labels.

Empty, loading, unavailable, and error states use written copy and structure before color.

Charts use ink lines, pale grids, paper backgrounds, and red points for the current focus.

Mobile layouts preserve the same evidence order and never rely on hover-only actions.

## Privacy language

“Only approved senders are in scope” describes the intended future boundary.

“Raw message text stays on this Mac” describes the target privacy posture rather than a production guarantee.

“No automatic Messages access” avoids suggesting unsupported access to an iPhone inbox.

“Prototype” remains visible so fixture data and local ledger evidence are not mistaken for a bank statement.

## Data rules

Fixture controls use fictional merchants, while scanned Messages events keep their parsed merchant, sender profile, amount, and date provenance locally.

Approved bank SMS entries remain distinct from manual entries.

Manual entries never change approved bank SMS totals.

Recurring patterns remain observations until the product has enough repeated evidence to label them confirmed.

Manual recurring rules are explicit local user choices and never become automatic evidence or payment instructions.

The redesign changes the visual system and route surface while keeping Messages read-only and separating automatic evidence from manual local rules.
