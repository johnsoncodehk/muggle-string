# Benchmarks

Two benches live here:

- `bench/suite`: the cases. Each times one operation of the library, or one pattern of a real consumer, and measures its memory, so a change shows on the cases of the cost it touches and nowhere else. This is the surface for performance work: measure a case before a change, and the same case after it.
- `bench/techniques`: what each technique of the source saves, by a variant of the source with only that technique taken out. The README of the repo shows its tables.

Both build the source into `bench/.build` with the TypeScript of the repo, run every measurement in a fresh Node process, and check that every build gives the same output, by hash, before they time anything.

## Running

```sh
pnpm bench                         # every case, 3 rounds, time and memory: about 10 minutes
pnpm bench --filter vue/           # cases whose name contains vue/; repeat --filter for more
pnpm bench --filter replace/ --quick   # 1 round, shorter sampling: a look while working
pnpm bench --against master        # the working tree against master, interleaved, 5 rounds
pnpm bench --against variant:cut-search   # against the working tree without a technique
pnpm bench --time-only             # or --memory-only
pnpm bench --list                  # the cases, their sizes and what each measures
pnpm bench:smoke                   # each case once at a tiny size, output checked; CI runs it
pnpm bench --out a.json            # also save the results; then:
pnpm bench:compare a.json b.json   # the change between two saved runs
pnpm bench:techniques              # the techniques bench
```

With npm, pass the options after `--`: `npm run bench -- --filter vue/`. The scripts are Node only, with no shell syntax, so they run the same on Windows.

A run writes `bench/.results/suite/latest.json` and `latest.md`. The JSON has the samples of every round, the conditions (Node, V8, CPU, platform) and the builds, so a later run can be compared with it.

## What a case measures

A case is a name, sizes, a unit, and a `setup(M, size)` that makes the inputs, untimed, and returns `run`: the work that is timed, from the inputs to an output. `M` is the build being measured, imported like the package. A case may also return `prepare`, untimed work that each `run` needs fresh, such as a rewrite that `run` renders for the first time.

For each case, each size and each build, a round spawns two processes:

- **Time.** The first run is *cold*: it includes parsing and compiling the code of the library, as in a process that compiles one file. Then warm-up runs for 300 ms, and 25 *samples*, each a batch of runs of at least 10 ms, as a timer reads a single short run coarsely. The process reports the median sample and the median absolute deviation of the samples, its *spread*. Across rounds, the report gives the median of the medians and their range.
- **Memory.** In a process of its own, so that warm-up does not set the high-water mark: the setup, two full GCs, then one cold run with `v8.GCProfiler` on. It reports:
  - *peak RSS growth*: the peak RSS of the process (`process.resourceUsage().maxRSS`) over the RSS right before the run. This is what a build tool sees. When the setup itself set the peak, the run grew it by at most that, and the report marks it `(≤)`.
  - *allocated*: bytes allocated on the V8 heap during the run, as the heap at its end less the heap at its start, plus what each GC in it freed. It barely varies between runs, so it shows a change of 1%, where time and RSS cannot. Typed array backing stores outside the heap are not in it.
  - *GC time*, and *retained*: the heap and array buffers that stay after a full GC with the inputs and the output held, which is the size of the rewrite and its output.

Before any of that, a *verify* run of every case on every build checks that two runs give one output, and that all builds give the same output. A change that changes output, such as of a source map, stops the comparison unless `--allow-output-change` is given, and the report marks those cases.

The output of a case is consumed in the timed code: strings built by concatenation are flattened there (`%FlattenString`, which is why workers run with `--allow-natives-syntax`), so the cost of building a string does not move out of the timing into whatever reads it first. The last output is kept in a global, so no run is dead code.

## Reading the numbers

- **Per unit** divides the time by the count of the unit of the case: edits, cuts, references, files. The micro cases make the text grow with the count of edits, 10 chars an edit, so the per-unit time of the sizes of a case is the same when the cost is linear. Where it grows from the small size to the large, a cost is not linear, or the large size leaves the CPU caches.
- **Spread** of a few percent is normal on a laptop; above 10%, the machine was busy, or GC ran in some samples and not others. Cases that allocate a lot have a larger spread, as their samples take turns with a GC.
- **Cold** times are of one run in one process: each round has one, so their median over rounds is all there is, and they move more.
- **Peak RSS** of small cases is mostly one-time costs of the process, such as the first `renderWithSourceMap` creating its `TextDecoder`. Read RSS on the large sizes, where the run dominates it; read *allocated* on all.
- **Comparisons** (`--against`) run both builds round by round, each round alternating which goes first, and divide the time of the current build by that of the base, round by round. A machine that slows down for a round slows both, so the ratio of the round stays. A time change is in bold when at least 80% of the rounds agree on its direction, and its median is at least 3% from 1 and at least twice the spread of the samples. With fewer than 3 rounds, nothing is called a change. Allocation changes are in bold from 1%. Peak RSS is shown, not judged.
- To learn the noise of a machine, compare the code with itself: `pnpm bench --against HEAD` on a clean tree. Every ratio should be close to 1 and none in bold; how far they stray is the smallest change the machine can show.
- `bench:compare` of two saved files cannot pair rounds, as they ran at different times: it calls a change only when the ranges of the rounds are apart as well. It warns when the Node version, CPU or platform differ, as then the numbers are of different machines, not of different code.

Numbers are of the machine and the Node version they ran on. They are comparable between runs on one machine, and the ratios of a comparison carry over to other machines better than the times do. No result is a baseline in the repo: a regression is measured by `--against`, on one machine, in one session.

## JIT and measurement pitfalls

- **One case per process.** V8 optimizes code for the shapes and types it has seen. A case that ran after another would run code that the other's types shaped, so its numbers would depend on the order of the cases. Every case runs in a fresh process instead.
- **Warm and cold differ by 2 to 5 times.** Warm numbers show the steady state of a long-running process, such as a language server or a dev server compiling many files; cold numbers show a CLI build that compiles each file once. An optimization can help one and hurt the other: more code to compile is slower cold.
- **Inputs are monomorphic.** A case makes one kind of piece, so the code sees one shape. Real consumers mix shapes, as Vue mixes strings, ranges with `text`, kept ranges and arrays. The Vue traces mix them as Vue does; a change that wins only on the micro cases may lean on monomorphism that real code does not have.
- **GC is part of the cost.** The samples are not run with GC off, and the time between them is not collected: an allocation that a run makes is paid by a later sample. Do not hide it by `gc()` between samples.
- **Lazy work moves.** A rope string, a sort deferred to the first render, a map built on first read: the case must include the read that pays for it. That is why outputs are flattened in the timed code, and why `replace/ordered:edits` is listed next to `replace/ordered:first-render`: the edits alone look cheap because they defer the sort.
- **Batches.** A sample of runs shorter than about 10 µs each is mostly timer and loop. The batch size comes from the warm-up, and the per-run time is the batch time divided by its count.
- **The machine.** Turbo boost, thermal throttling, other processes and a laptop on battery all move numbers by more than most changes. Close what you can, keep the machine plugged in, and compare in one session.

## The cases

The micro cases each isolate one cost. The Vue traces replay the calls that Vue's `compileScript` makes on a rewrite, in its order, with the pieces it passes, after the muggle-string port of `@vue/compiler-sfc` ([vuejs/core#16126](https://github.com/vuejs/core/pull/16126)): `cases/sfc.mjs` generates a component with the offsets that its parse would give, so the trace needs no parser or compiler. The hottest paths there are many small `replace` and `cut` calls, and `render` with `renderWithSourceMap`, whose RSS is the cost of compiling with source maps, which `compileScript` writes unless `sourceMap` is false.

| Case | Measures | Why |
|---|---|---|
| `create` | creating a rewrite and rendering it untouched | the fixed cost of a file; a dev server pays it for each one |
| `insert/same-offset` | many inserts at one offset | code piled at one place, such as a preamble; equal keys in the sort |
| `insert/ordered`, `insert/random` | inserts at distinct offsets, in source order or not | the append-only edits and the sort that the first render does when they come out of order |
| `replace/ordered`, `replace/random` | small replaces with mapped text, as Vue's `ctx.replace` | the most frequent call of Vue: each reference of a destructured prop, each macro callee |
| `replace/ordered:edits`, `:first-render`, `:render-again` | the phases of `replace/ordered`: the calls, the first render that sorts and compiles, a later render | which phase a change saves in; the sum is about `replace/ordered` |
| `replace/overlapping-removals` | `replace(start, end, '')` of ranges that overlap and nest | Vue removes import specifiers up to the next one, then the whole import; `defineModel` removes options |
| `writers/stacked-insert-after` | `insertAfter` at one end by 4 writers of rising rank | the closes of nested awaits, where rank is the order of nesting |
| `writers/mixed-ordered`, `writers/mixed-random` | inserts and replaces from 4 writers | the merge of the edits of several writers |
| `cut/move-ordered`, `cut/move-random` | cuts placed at once by `insertBefore(0, cut)` | Vue hoists every import and type declaration so |
| `cut/placed-twice` | each slice placed at two places | a slice renders wherever it is placed |
| `copy/ranges-twice` | the ranges of `cut/placed-twice` inserted as kept ranges, twice | Vue's `ctx.copy` repeats macro arguments this way; unlike a cut, the text also stays where it was, so this is a different operation, listed next to it for the cost of each |
| `cut/nested` | cuts each inside the last, each placed in the one around it | the render recurses through slices |
| `render/sink-only` | a later render to a sink that keeps no string | the render alone, without `rewritePieceText` and string building |
| `render/views` | 5,000 views of 200 chars | a language server renders blocks of one rewrite as views |
| `map/rewrite`, `map/rewrite-non-ascii` | `renderWithSourceMap` of a rendered rewrite, ASCII or not | the map writer on top of `render/sink-only`; non-ASCII text takes the slower char classes |
| `map/decoded`, `map/encode`, `map/decode` | the decoded map, and the v3 encoder and decoder alone | consumers that work on segments, such as Vue's tests and tools |
| `map/pieces` | `renderWithSourceMap` of an array of pieces | the map writer without a rewrite |
| `vue/sfc:text`, `vue/sfc:map` | the whole `compileScript` trace of a typical component, scaled 1, 100 and 1,000 times, to text or with a map | the end-to-end cost; scale 1 is the per-file cost, the large scales the RSS of rendering with a map |
| `vue/props-references:map` | a component with many references of destructured props | many small mapped replaces, the hottest Vue pattern |
| `vue/hoist:map` | a component with many imports and types | many small cuts placed at 0, and the removals of their specifiers |
| `vue/awaits:text` | a component with many top-level awaits, half nested | a replace and a ranked `insertAfter` for each, two of them at one end where awaits nest |
| `vue/template:map` | the pieces of template code mapped without a rewrite | `compileTemplate` maps its code with `renderWithSourceMap` this way |

The trace of `compileScript` covers what the port does to `<script setup>`: imports hoisted by `insertBefore(0, cut(...))` and their macro and duplicate specifiers removed; a normal `<script>` after `<script setup>` moved up by a cut of its range, and its `export default` replaced; macros removed or replaced; `defineModel` options removed and copied; awaits wrapped, closes stacked by `writer(rank).insertAfter`; references of destructured props replaced, shorthands extended by `insertAfter`; everything but the scripts removed by `replace(0, startOffset, '')` and the like; then code inserted on chars that those removals deleted, which must still render: css vars, async context and the setup head by `insertAfter(startOffset, ...)` on the `>` of the start tag, the return and the setup tail by `insertBefore(endOffset, ...)` on the `<` of the end tag; and the preamble and helper imports by `insertAfter(0, ...)`, which is before all text, not on a deleted char.

## Adding and changing cases

- **A name is a promise.** Results are keyed by case name and size. Do not change the inputs or the work of an existing case: its old numbers would stop meaning the same. Add a case, or a size, with a new name, and remove the old one when nobody compares with it any more.
- **Before an optimization, its case.** Find or add the case whose cost the change targets, so that the change moves it and the report shows before and after by `pnpm bench --against master --filter <case>`. Then run every case: a change that saves on one case and costs on another should show both.
- **A case for each real pattern.** A case should be an operation that a consumer makes, or a pattern of one, with the sizes it has: when a consumer is found to do something that no case covers, add a case for it, with a line in the table above on why it exists.
- **Keep the output.** A case returns what the operation gives, and the verify run checks it on every build. A case that returns nothing measures nothing that a consumer gets.
- **Vue traces follow Vue.** When `compileScript` changes how it calls the rewrite, change `cases/sfc.mjs` to match, under a new case name if the numbers change.

## Not gaming the benches

- No code in `src` that knows the inputs: their offsets, sizes, seeds or the shape of the text. An optimization must hold for the edits of any consumer.
- No work moved out of the timed code that a consumer pays for: no strings left as ropes, no work deferred past the output, no cache that a later run of the same inputs hits but a new file would not. `:render-again` cases measure a reused rewrite on purpose; the others make a new rewrite per run.
- No trading memory for time unseen: the memory runs show allocation and RSS next to time, and the change of both belongs in the description of the change.
- No case removed or resized because it got slower.
- Report the whole table of a change, not the case it was for.

## Other libraries

The suite measures muggle-string against its own history, not against other libraries. magic-string mutates one string by offsets of the original, and keeps a source map alongside, while a rewrite collects ranked edits and maps by the pieces it renders: few of their operations do the same work, and a table of both would compare different things under one name. The techniques bench keeps two baselines that do the same work as a rewrite: the 0.4 segment array of this package, and a sorted array that splices each edit in.
