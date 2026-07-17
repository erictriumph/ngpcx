# NGPCX / CheckMyARM — What It Is
Updated 2026-07-17

## The problem
Windows laptops built on ARM chips (Qualcomm Snapdragon, marketed as "Copilot+ PCs") are becoming more common — they're fast, have great battery life, and Microsoft is pushing them hard. But there's a catch: not every Windows app or device driver works on ARM the same way it does on a traditional Intel/AMD laptop. Some software runs natively (full speed), some runs through an emulation layer (works, but slower and worse for battery), and a small number won't run at all.

Right now, there's no easy way for someone to check *their own* specific situation before buying. You'd have to research every app and every peripheral (printer, webcam, headset, etc.) one by one — tedious, and easy to get wrong.

## What the tool does
It's a free scanner (**CheckMyARM**, brand name — NGPCX is the underlying project name) someone can run on their current Windows laptop that:
- Looks at what apps and devices are actually installed and in use on their machine — not just installed, but *used*: currently running, launched from the taskbar or Start Menu, set as a startup app, or genuinely opened recently (not just present on disk)
- Checks each one against a database of nearly 9,000 known ARM compatibility verdicts, cross-referenced from multiple sources
- Gives a plain-language report: what will work great, what will work but slower, what won't work, and what's simply unknown yet — plus a single readiness score and a confidence rating that's honest about how much of the picture is actually filled in

The goal is a genuinely useful "am I ready to switch?" answer, in a few minutes, without needing any technical background to understand the result.

**What's new since the tool first worked:** the experience has grown from a one-shot "scan, get a report" tool into a small, ongoing workflow. A person can come back and refine their results over time — flagging what actually matters to them, correcting the computer's assumptions, marking things they've personally verified — without ever having to re-scan or lose their progress. The system also gets smarter passively: it now notices things like which apps someone actually opens (versus apps that are just installed and forgotten), whether an app is pinned to their taskbar, and which browser/mail app is their real default — all of which sharpen *what deserves attention* without the person doing anything extra. And a community layer lets other users (anonymous or signed in) report real-world results for the apps the catalog doesn't know yet, which a small volunteer "Researcher" role reviews before it becomes an official verdict.

## Who it's for
Anyone personally considering a Snapdragon/ARM Windows laptop and wanting to know if their day-to-day software and hardware will keep working before they buy — not IT departments doing bulk purchasing decisions, just individual people making their own choice.

## Where it stands
It's a working, functional tool with real depth now — assessment logic, a community contribution loop, optional sign-in, and a proper navigation shell that adapts to who's using it. Still in private testing, ahead of a wider soft-launch to a small trusted group. The one concrete blocker left before wider distribution is code signing the scanner executable (in progress, not yet done) — everything else is refinement, not a gate.

## Why it exists
It scratched a real personal itch — no equivalent tool existed — and turned into a genuine learning project with real-world utility, built by someone with a long background in cybersecurity who wanted both the challenge and the chance to help people make a well-informed purchase.
