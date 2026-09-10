# Class / event image file upload

Apply `class-image-upload.patch` to `manager.html` on `main` (or merge the PR that updates `manager.html` directly).

Adds device file upload (`image/*`, 25MB cap) to Manager → Tickets → Add/Edit Class|Event alongside existing Canva/URL Import (`emcHostImage` → `social-assets`). Uses the same `db.storage.from('social-assets')` pattern as Social Posts.
