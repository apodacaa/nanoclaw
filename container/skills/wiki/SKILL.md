# Wiki — Container Skill

You maintain a persistent, compounding wiki knowledge base. The wiki lives in your group folder at `wiki/` with raw sources in `sources/`.

## Architecture

- **`sources/`** — Raw source files (PDFs, saved articles, transcripts). Immutable once added. You read these but never modify them.
- **`wiki/`** — Your wiki pages. You own these entirely. Create, update, reorganize as needed.
- **`wiki/index.md`** — Catalog of every wiki page with one-line summaries, organized by topic. Read this first when answering queries.
- **`wiki/log.md`** — Append-only chronological record of all wiki activity.

## Operations

### Ingest

When the user provides a source (URL, file, PDF, image, voice note, or typed knowledge):

1. **Save the source.** Download or copy the raw material into `sources/`. For URLs, use `curl -sLo sources/filename.ext "<url>"` to get the full content (not a summary). For web pages where curl gives HTML, use `agent-browser` to open the page and extract the text. For files sent via chat, they'll appear as attachments — copy them to `sources/`.

2. **Read and discuss.** Read the full source. Share key takeaways with the user. This is a conversation — discuss what's interesting or surprising before filing.

3. **Create or update wiki pages.** Based on the source content:
   - Create a **summary page** for the source itself
   - Create or update **entity pages** for people, organizations, tools, or things mentioned
   - Create or update **concept pages** for ideas, patterns, or themes
   - Add **cross-references** between pages using markdown links (`[Related Page](related-page.md)`)
   - Flag any **contradictions** with existing wiki content

4. **Update the index.** Add new pages to `wiki/index.md` with one-line summaries. Reorganize categories if needed.

5. **Log the ingest.** Append to `wiki/log.md`:
   ```
   ## [YYYY-MM-DD] ingest | Source Title
   Added: page1.md, page2.md. Updated: existing-page.md. Key topics: ...
   ```

**Critical: one source at a time.** When given multiple sources, process them sequentially. For each source: read it fully, discuss takeaways, create/update all wiki pages, update the index and log, and completely finish before moving to the next source. Never batch-read multiple sources and then process them together — this produces shallow, generic pages.

### Query

When the user asks a question:

1. Read `wiki/index.md` to locate relevant pages
2. Read those pages
3. Synthesize an answer with references to wiki pages
4. If the answer reveals a gap, mention it — suggest sources to fill it
5. If the answer is worth keeping, offer to file it as a new wiki page
6. Log the query in `wiki/log.md`

### Lint

Periodically (or when asked), health-check the wiki:

- **Contradictions** — pages that disagree with each other
- **Orphans** — pages with no inbound links from other pages
- **Stale content** — claims superseded by newer sources
- **Missing pages** — important concepts referenced but lacking dedicated pages
- **Missing cross-references** — pages that should link to each other but don't
- **Gaps** — topics that need more sources

Report findings and offer to fix issues. Log the lint pass.

## Page Conventions

Keep it light — don't over-structure. General guidelines:

- One markdown file per page in `wiki/`
- Use descriptive filenames: `kubernetes-networking.md`, `andrej-karpathy.md`
- Start each page with a `# Title`
- Include a `## Sources` section at the bottom listing which raw sources informed the page
- Cross-reference freely with relative markdown links
- Pages can be any length — short stubs are fine, they'll grow over time
- No rigid template — let the content dictate the structure
