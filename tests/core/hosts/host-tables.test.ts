import { describe, expect, it } from 'vitest';
import { hostOfPrUrl, hostOfThread, knownHosts } from '../../../src/core/hosts/index.js';
import { commandsFor, hostName } from '../../../src/core/hosts/commands.js';
import { parsePrLink, threadHostId } from '../../../src/core/hosts/links.js';
import { azureThreadId } from '../../../src/core/hosts/azure/origin.js';

/**
 * A host is listed in four places: the registry (index.ts), the command table
 * (commands.ts), and the SPA's pure link and thread-id readers (links.ts).
 * Left out of one, it silently read as GitHub there (its prompts told to run
 * gh). Nothing is registered in this file: these are the built-in hosts alone.
 */

describe("the built-in hosts' tables agree (#63 review F013)", () => {
  // One sample per built-in host: a host added to the registry without one here fails the first test.
  const SAMPLES: Record<string, { link: string; thread: string }> = {
    github: { link: 'https://github.com/acme/api/pull/7', thread: 'PRRT_kwDOabc123' },
    azure: {
      link: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7',
      thread: azureThreadId({ orgUrl: 'https://dev.azure.com/acme', project: 'Shop', repo: 'api' }, 7, 3),
    },
  };
  const builtIn = () => knownHosts();

  it('every built-in host has a sample here', () => {
    expect(
      builtIn()
        .map((h) => h.id)
        .sort(),
    ).toEqual(Object.keys(SAMPLES).sort());
  });

  it("each host's commands, name, link reader and thread ids are the ones the SPA's pure tables give", () => {
    for (const h of builtIn()) {
      const s = SAMPLES[h.id];
      expect(commandsFor(h.id), h.id).toBe(h.commands); // not GitHub's by default
      expect(hostName(h.id)).toBe(h.name);
      expect(h.parsePrUrl(s.link), h.id).not.toBeNull();
      expect(parsePrLink(s.link)?.host).toBe(h.id);
      expect(hostOfPrUrl(s.link)?.host.id).toBe(h.id);
      expect(h.threads.isId(s.thread), h.id).toBe(true);
      expect(threadHostId(s.thread)).toBe(h.id);
      expect(hostOfThread(s.thread)?.id).toBe(h.id);
    }
  });
});
