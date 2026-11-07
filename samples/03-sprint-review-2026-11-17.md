# 📝 Notes

Nov 17, 2026

## Sprint Review — CLI toolkit team

Invited [Lena Hoffmann](mailto:lena@example.com) [Omar Said](mailto:omar@example.com) [Priya Nair](mailto:priya@example.com) [Tom Becker](mailto:tom@example.com)

Meeting records [Transcript](https://example.com/transcript)

### Summary

The team reviewed progress. Support again raised that users don't learn which environment variable can provide a mandatory option; the team re-confirmed the fix and added that the help text should also mark mandatory options. A new action was agreed to warn when two options share the same environment variable.

### Details

* **Env variable hint for mandatory options**: Priya repeated the support complaint: when a mandatory option is not given, users should be told which environment variable they can set instead. Lena confirmed it is planned; the team added that the hint must also work for options defined on parent commands. ([00:03:00](#00:03:00))
* **Duplicate env variable warning**: Tom found two options in a sample app bound to the same environment variable, silently. The team agreed to report this as an error when the options are added, like duplicate flags. Tom owns it. ([00:08:20](#00:08:20))

### Suggested next steps

- [ ] Lena Hoffmann will make the missing mandatory option message tell users which environment variable to set, including for options on parent commands.
- [ ] Tom Becker will detect options that share the same environment variable.

---

*You should review Gemini's notes to make sure they're accurate.*

# 📖 Transcript

Nov 17, 2026

## Sprint Review — CLI toolkit team - Transcript

### 00:03:00

**Priya Nair:** Support pinged me again. When you don't pass a mandatory option, the message should tell you which environment variable you can set instead.
**Lena Hoffmann:** That's the one I took two weeks ago, it's still planned.
**Omar Said:** Make sure it also works when the option is defined on a parent command and checked from a subcommand.
**Lena Hoffmann:** Good point, I'll include that.

### 00:08:20

**Tom Becker:** While testing I had two options using the same env variable and nothing complained. It's confusing which one wins.
**Omar Said:** We already throw for duplicate flags. Let's throw for that too when the option is added.
**Lena Hoffmann:** Agreed. Tom, yours?
**Tom Becker:** Yes.
