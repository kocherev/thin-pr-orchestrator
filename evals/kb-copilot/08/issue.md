# Check the upload limits in the browser before sending files

The API takes at most 20 files per upload and 2 MB per file. The upload form says so in its hint, but it lets you pick any number of files of any size and sends them all. Someone who picks 25 files, or one 30 MB PDF, waits for the upload and only then gets a 400 or 413 from the API.

Done when:
- Choosing more than 20 files, or any file over 2,000,000 bytes, shows an alert right away and keeps Upload disabled. The size message names the file.
- Exactly 20 files, and a file of exactly 2,000,000 bytes, are allowed.
- Choosing a valid set again clears the message. Nothing is sent for a refused selection.
