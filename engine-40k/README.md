# Engine 40K — browser-first prototype

Working label, not a settled product name. The first milestone is a complete phone editing loop with **actual C# gameplay**, not Unity feature parity.

## Decisions

The editor interface is browser-native. The initial implementation is HTML/CSS/JavaScript, with TypeScript planned for maintained schemas and command interfaces. Three.js/WebGL2 supplies the initial viewport. There is no C native core in this prototype. Introduce C/WASM only where profiling or a native target justifies it; C++ is not a prerequisite.

Roslyn 4.14 compiles Game.cs inside .NET WebAssembly. The compiled assembly executes in a dedicated Web Worker. Start, Update and Tap are actual C# methods. No C#-to-JavaScript toy parser is involved. This is a small Engine40K API, not UnityEngine compatibility.

The authoring project and play-mode scene are separate. Compilation receives a copy of the scene. Stop restores authored data. Invalid project patches are rejected; applying source does not run it. Worker cancellation protects the editing session from a stuck script, but is not a security guarantee for arbitrary untrusted code.

The first bridge uses JSON snapshots. Optimize measured marshaling costs with dirty-state and batched numeric buffers before changing implementation languages. The editor's source and command surface should remain independent of any later renderer or C core.

## Phone workflow

Open the HTML, edit the scene or C# source, and press Play. The bottom workspace is draggable; Reset, Undo, Redo, Play, Pause and Stop remain in its top row. Drag the view to orbit; two fingers pan/zoom. In Crystal Garden, tap crystals or use the virtual joystick.

The AI panel copies the exact request plus API, source and scene for use with the user's existing AI service. Paste a complete C# source block or versioned project patch, inspect it, then Play. **There is no integrated AI model in this milestone.** Scene editing and preview do not require model calls.

Save locally and export an independent project file. Browser storage can be evicted or cleared; it is not permanent backup. Private browsing may restrict persistence. No desktop SDK is needed to use the built editor. SDKs are used by the automated build, not by the game author for each script edit.

## Plan and acceptance gates

1. **Prove the complete loop.** Scene selection, transforms, primitive creation, duplicate/delete, undo/redo, C# compile/execute/recompile, source-linked diagnostics, touch input, pause/stop, save/reopen and export. Verify panel resizing does not change render dimensions or camera projection. Test the actual packaged artifact.
2. **Harden phone use.** Software-keyboard accommodation, text selection, reliable paste, progress/cancellation, crash recovery, local project migration, transactional IndexedDB asset storage and runtime-only sharing. Measure cold/warm startup and compile latency on a physical phone.
3. **Build useful small games.** Parenting, component lifecycle, prefabs, cameras/lights, model/texture import, input actions, audio/UI and a tested physics integration. Prove reuse by building two different games, not only one showcase.
4. **Integrate AI deliberately.** User-provided model access, explicit authentication, documented command/patch schema, visible diffs, validation, compile/test feedback and reversible changes. Do not ship a company secret in client code or pretend an API key is subscription sign-in.
5. **Optimize and expand targets.** Profile rendering, scripts, allocations and interop separately. Consider C for specific subsystems. Separate interpreted development preview from production web/native builds. Native export, platform signing and deployment require their own acceptance tests.

## Current scope

Primitive scene editing; one C# gameplay source file; a small documented entity API; local save/import/export; AI handoff; compiler/runtime console. Protective limits: 512 authored objects, 4096 runtime objects, 256 KiB source. These are limits, not phone performance claims.

Not implemented: a C native core, general physics engine, model/texture importer, native exporter, debugger, integrated AI model or collaboration service. WebGPU is not implemented. The default demo's collection check is gameplay distance logic, not a physics engine.

## Build and evidence

`build_runtime.py` builds .NET and bundles the graphics dependencies. `package_single.py` embeds the runtime and compiler into one HTML file. `smoke_runtime.py` proves real C# compilation, LINQ, reflection, events and recompilation. `test_editor.py` exercises the touch interface. `test_single.py` checks offline startup, new C# source and recovery from an infinite loop.

`apply_source_fixes.py` contains narrowly checked, idempotent corrections identified by the initial acceptance pass. The workflow commits corrected source only after all acceptance tests pass; the corrected editor remains ordinary readable JavaScript.

The GitHub Actions workflow is isolated to `engine-40k-20261010`. Existing demo directories and `main` are not deployment targets. Read the JSON test reports for the actual result; a plan or screenshot is not proof of execution. Touch emulation is not a physical Android benchmark.

## References

Microsoft .NET/JavaScript interop: https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-interop/?view=aspnetcore-10.0

Three.js WebGLRenderer: https://threejs.org/docs/pages/WebGLRenderer.html

Browser storage and eviction: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria

Worker lifetime: https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate

Worker construction: https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker
