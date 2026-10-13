<!-- Template: bug report -->
**Describe the bug**
Pasting an image moves the cursor to the end.

<details>
<summary>Log</summary>

```
TypeError: Cannot read properties of null (reading 'selectionStart')
    at insertImages (upload.ts:52:21)
```

</details>

![Screenshot](https://happy-otter-123.convex.site/img/abc123def456 "Screenshot")

Video: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing

* Browser: Firefox 141
* OS: Linux
    * Kernel 7.2

Keys: <kbd>Ctrl</kbd> + <kbd>V</kbd><br>
Thanks!
