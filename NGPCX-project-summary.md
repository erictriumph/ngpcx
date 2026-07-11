# NGPCX / CheckMyARM — What It Is

## The problem
Windows laptops built on ARM chips (Qualcomm Snapdragon, marketed as "Copilot+ PCs") are becoming more common — they're fast, have great battery life, and Microsoft is pushing them hard. But there's a catch: not every Windows app or device driver works on ARM the same way it does on a traditional Intel/AMD laptop. Some software runs natively (full speed), some runs through an emulation layer (works, but slower and worse for battery), and a small number won't run at all.

Right now, there's no easy way for someone to check *their own* specific situation before buying. You'd have to research every app and every peripheral (printer, webcam, headset, etc.) one by one — tedious, and easy to get wrong.

## What the tool does
It's a free scanner someone can run on their current Windows laptop that:
- Looks at what apps and devices are actually installed and in use on their machine
- Checks each one against a database of known ARM compatibility
- Gives a plain-language report: what will work great, what will work but slower, what won't work, and what's simply unknown yet

The goal is a genuinely useful "am I ready to switch?" answer, in a few minutes, without needing any technical background to understand the result.

## Who it's for
Anyone personally considering a Snapdragon/ARM Windows laptop and wanting to know if their day-to-day software and hardware will keep working before they buy — not IT departments doing bulk purchasing decisions, just individual people making their own choice.

## Where it stands
It's a working, functional tool, still being actively refined and tested. Right now it's being tested privately before a wider soft-launch to a small trusted group.

## Why it exists
It scratched a real personal itch — no equivalent tool existed — and turned into a genuine learning project with real-world utility, built by someone with a long background in cybersecurity who wanted both the challenge and the chance to help people make a well-informed purchase.
