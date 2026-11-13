# RouterAI

[RouterAI](https://routerai.ru) puts models from many vendors — Anthropic, OpenAI, Google, DeepSeek, Qwen and
others — behind a single key and bills in rubles. This plugin adds those models to DeepSeek Harness.

## Getting started

1. Open **Settings → RouterAI** and press **Sign in with RouterAI**. Approve access on routerai.ru and the key
   is saved for you. You can also paste an existing key there.
2. Tick the models you want in the catalog and press **Apply**.
3. Pick a RouterAI model in the model picker.

## What you get

- Price per million tokens and context size right in the model list.
- Balance in the sidebar and the session cost under the composer.
- Clear messages when the balance runs out or the key hits its spending limit.
- Savings: session titles and context compaction run on an inexpensive utility model.
- The `/routerai` command for the same actions from the chat: `login`, `key`, `logout`, `status`, `models`, `find`.
