import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	blobSha,
	GitHub,
	isCacheFresh,
	mapLimit,
	ObjectStore,
	type Checkout,
	type RepoInfo,
} from './github';

/** A token from the environment keeps the constructor away from the `gh` binary. */
function client(): GitHub {
	vi.stubEnv('GITHUB_TOKEN', 'test-token');
	return new GitHub({ cache: false });
}

function reply(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
	} as Response;
}

const repo = (name: string, overrides: Partial<RepoInfo> = {}): RepoInfo => ({
	name,
	description: null,
	language: null,
	archived: false,
	fork: false,
	defaultBranch: 'main',
	...overrides,
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('mapLimit', () => {
	it('keeps results in the order of the input, not of completion', async () => {
		const result = await mapLimit([30, 10, 20], async (delay) => {
			await new Promise((done) => setTimeout(done, delay));
			return delay;
		});
		expect(result).toEqual([30, 10, 20]);
	});

	it('never runs more than a dozen at once', async () => {
		let running = 0;
		let peak = 0;
		await mapLimit(
			Array.from({ length: 40 }, (_, i) => i),
			async () => {
				running++;
				peak = Math.max(peak, running);
				await new Promise((done) => setTimeout(done, 1));
				running--;
				return null;
			},
		);
		expect(peak).toBeLessThanOrEqual(12);
		expect(peak).toBeGreaterThan(1);
	});

	it('copes with nothing to do', async () => {
		expect(await mapLimit([], () => Promise.resolve(null))).toEqual([]);
	});
});

describe('isCacheFresh', () => {
	const HOUR = 3_600_000;

	it('keeps a response for a day, and no longer', () => {
		expect(isCacheFresh(0, 23 * HOUR)).toBe(true);
		expect(isCacheFresh(0, 24 * HOUR)).toBe(false);
		expect(isCacheFresh(0, 200 * HOUR)).toBe(false);
	});
});

describe('listRepos', () => {
	it('follows pagination until a short page arrives', async () => {
		const page = (count: number, from: number): unknown[] =>
			Array.from({ length: count }, (_, i) => ({
				name: `repo-${String(from + i).padStart(3, '0')}`,
				description: null,
				language: null,
				archived: false,
				fork: false,
				default_branch: 'main',
			}));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(reply(page(100, 0)))
			.mockResolvedValueOnce(reply(page(7, 100)));
		vi.stubGlobal('fetch', fetchMock);

		const repos = await client().listRepos('versatiles-org');
		expect(repos).toHaveLength(107);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
	});

	it('asks only for public repositories, and sorts what comes back', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			reply([
				{ name: 'zebra', default_branch: 'main', archived: false, fork: false },
				{ name: 'alpha', default_branch: 'trunk', archived: true, fork: true },
			]),
		);
		vi.stubGlobal('fetch', fetchMock);

		const repos = await client().listRepos('versatiles-org');
		expect(String(fetchMock.mock.calls[0][0])).toContain('type=public');
		expect(repos.map((r) => r.name)).toEqual(['alpha', 'zebra']);
		// The API spells it default_branch; everything downstream expects camelCase.
		expect(repos[0]).toMatchObject({ defaultBranch: 'trunk', archived: true, fork: true });
	});
});

const COMMIT = 'c'.repeat(40);

/** What a tree listing says about a file with this content. */
const blob = (path: string, text: string) => ({
	path,
	type: 'blob',
	size: Buffer.byteLength(text),
	sha: blobSha(text),
});

/** A checkout that knows nothing about its files, so that every read asks GitHub. */
const unlisted = (name: string, ref = 'main'): Checkout => ({
	repo: name,
	ref,
	files: new Map(),
	complete: false,
	entries: [],
});

describe('blobSha', () => {
	it('hashes a file the way git does', () => {
		// `printf 'hello\n' | git hash-object --stdin`
		expect(blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
		expect(blobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
	});
});

describe('heads', () => {
	it('finds the head commit of every repository, page by page', async () => {
		const page = (names: string[], next: string | null) =>
			reply({
				data: {
					organization: {
						repositories: {
							pageInfo: { hasNextPage: next !== null, endCursor: next },
							nodes: names.map((name) =>
								name === 'empty'
									? { name, defaultBranchRef: null }
									: { name, defaultBranchRef: { target: { oid: `${name}-head` } } },
							),
						},
					},
				},
			});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(page(['a', 'empty'], 'cursor-1'))
			.mockResolvedValueOnce(page(['b'], null));
		vi.stubGlobal('fetch', fetchMock);

		const heads = await client().heads('versatiles-org');
		expect([...heads]).toEqual([
			['a', 'a-head'],
			['b', 'b-head'],
		]);
		const second = JSON.parse(
			(fetchMock.mock.calls[1] as [string, { body: string }])[1].body,
		) as {
			variables: { after: string };
		};
		expect(second.variables.after).toBe('cursor-1');
	});

	it('fails rather than pretend an unknown organisation has no repositories', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ data: { organization: null } })));
		await expect(client().heads('nobody')).rejects.toThrow(/no organisation/);
	});
});

describe('checkout', () => {
	it('lists only blobs, and offers only those small enough to be a manifest', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				reply({
					tree: [
						{ path: 'package.json', type: 'blob', size: 400, sha: 'a'.repeat(40) },
						{ path: 'src', type: 'tree', sha: 'b'.repeat(40) },
						{
							path: 'data/planet.pmtiles',
							type: 'blob',
							size: 900 * 1024,
							sha: 'd'.repeat(40),
						},
						{ path: 'no-size', type: 'blob', sha: 'e'.repeat(40) },
					],
				}),
			),
		);
		const checkout = await client().checkout('versatiles-org', repo('versatiles-rs'), COMMIT);
		expect(checkout.entries.map((entry) => entry.path)).toEqual(['package.json', 'no-size']);
		// A lockfile can be bigger than a manifest and still be read.
		expect([...checkout.files.keys()]).toEqual([
			'package.json',
			'data/planet.pmtiles',
			'no-size',
		]);
	});

	it('names the commit when it is known, and the branch when not', async () => {
		const fetchMock = vi.fn().mockResolvedValue(reply({ tree: [] }));
		vi.stubGlobal('fetch', fetchMock);
		const github = client();

		expect((await github.checkout('versatiles-org', repo('x'), COMMIT)).ref).toBe(COMMIT);
		expect(String(fetchMock.mock.calls[0][0])).toContain(`/git/trees/${COMMIT}?recursive=1`);
		expect((await github.checkout('versatiles-org', repo('x'), null)).ref).toBe('main');
		expect(String(fetchMock.mock.calls[1][0])).toContain('/git/trees/main?recursive=1');
	});

	it('says so when GitHub truncates the listing, and trusts it less', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ truncated: true, tree: [] })));
		const checkout = await client().checkout('versatiles-org', repo('huge'), COMMIT);
		expect(warn.mock.calls.flat().join(' ')).toContain('truncated');
		expect(checkout.complete).toBe(false);
		warn.mockRestore();
	});

	it('treats a repository with no tree as empty rather than failing', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({}, 404)));
		const checkout = await client().checkout('versatiles-org', repo('empty'), null);
		expect(checkout.entries).toEqual([]);
		expect(checkout.files.size).toBe(0);
	});
});

describe('readFile', () => {
	it('reads from raw.githubusercontent at the commit, which the API rate limit does not cover', async () => {
		const fetchMock = vi.fn().mockResolvedValue(reply('name = "versatiles"'));
		vi.stubGlobal('fetch', fetchMock);

		const text = await client().readFile(
			'versatiles-org',
			unlisted('versatiles-rs', COMMIT),
			'Cargo.toml',
		);
		expect(text).toBe('name = "versatiles"');
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			`https://raw.githubusercontent.com/versatiles-org/versatiles-rs/${COMMIT}/Cargo.toml`,
		);
	});

	it('returns nothing for a file that is not there', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('', 404)));
		expect(await client().readFile('versatiles-org', unlisted('x'), 'gone.json')).toBe(null);
	});

	it('does not ask for a file that a complete listing does not have', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const checkout: Checkout = { ...unlisted('x', COMMIT), complete: true };
		expect(await client().readFile('versatiles-org', checkout, 'gone.json')).toBe(null);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('the object store', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'dependency-graph-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const stored = (): GitHub => {
		vi.stubEnv('GITHUB_TOKEN', 'test-token');
		return new GitHub({ cache: false, store: dir });
	};

	it('reads an unchanged repository again without a single request', async () => {
		const manifest = '{"name":"x"}\n';
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(reply({ tree: [blob('package.json', manifest)] }))
			.mockResolvedValueOnce(reply(manifest));
		vi.stubGlobal('fetch', fetchMock);

		const first = stored();
		const checkout = await first.checkout('versatiles-org', repo('x'), COMMIT);
		expect(await first.readFile('versatiles-org', checkout, 'package.json')).toBe(manifest);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const second = stored();
		const again = await second.checkout('versatiles-org', repo('x'), COMMIT);
		expect(await second.readFile('versatiles-org', again, 'package.json')).toBe(manifest);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(second.storedCount).toBe(2);
		expect(second.requestCount).toBe(0);
	});

	it('reuses a file that a new commit left alone', async () => {
		const manifest = '{"name":"x"}\n';
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(reply({ tree: [blob('package.json', manifest)] }))
			.mockResolvedValueOnce(reply(manifest))
			.mockResolvedValueOnce(
				reply({ tree: [blob('package.json', manifest), blob('README.md', 'new')] }),
			);
		vi.stubGlobal('fetch', fetchMock);

		const github = stored();
		const old = await github.checkout('versatiles-org', repo('x'), COMMIT);
		await github.readFile('versatiles-org', old, 'package.json');
		const next = await github.checkout('versatiles-org', repo('x'), 'f'.repeat(40));
		expect(await github.readFile('versatiles-org', next, 'package.json')).toBe(manifest);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('fetches a stored file again when it no longer matches its hash', async () => {
		const manifest = '{"name":"x"}\n';
		const sha = blobSha(manifest);
		mkdirSync(join(dir, 'blobs'), { recursive: true });
		writeFileSync(join(dir, 'blobs', sha), '{"name":"damaged"}\n');
		const fetchMock = vi.fn().mockResolvedValue(reply(manifest));
		vi.stubGlobal('fetch', fetchMock);

		const checkout: Checkout = {
			...unlisted('x', COMMIT),
			files: new Map([['package.json', { path: 'package.json', size: 13, sha }]]),
			complete: true,
		};
		expect(await stored().readFile('versatiles-org', checkout, 'package.json')).toBe(manifest);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(dir, 'blobs', sha), 'utf8')).toBe(manifest);
	});

	it('stores neither a listing named by a branch nor a truncated one', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(reply({ tree: [] })));
		vi.stubGlobal('fetch', fetchMock);
		const github = stored();
		await github.checkout('versatiles-org', repo('x'), null);
		await github.checkout('versatiles-org', repo('x'), null);
		fetchMock.mockImplementation(() => Promise.resolve(reply({ truncated: true, tree: [] })));
		await github.checkout('versatiles-org', repo('x'), COMMIT);
		await github.checkout('versatiles-org', repo('x'), COMMIT);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		warn.mockRestore();
	});

	it('never stores what does not match its hash', () => {
		const store = new ObjectStore(dir);
		store.writeBlob(blobSha('right'), 'wrong');
		expect(store.readBlob(blobSha('right'))).toBeNull();
		store.writeBlob('../escape', 'text');
		expect(store.readBlob('../escape')).toBeNull();
	});
});

describe('when GitHub misbehaves', () => {
	it('retries a server error and counts both attempts', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(reply('', 502))
			.mockResolvedValueOnce(reply('recovered'));
		vi.stubGlobal('fetch', fetchMock);

		const github = client();
		expect(await github.readFile('versatiles-org', unlisted('x'), 'a.txt')).toBe('recovered');
		expect(github.requestCount).toBe(2);
	});

	it('gives up at once on an error that retrying cannot fix', async () => {
		const fetchMock = vi.fn().mockResolvedValue(reply('', 401));
		vi.stubGlobal('fetch', fetchMock);

		await expect(client().readFile('versatiles-org', unlisted('x'), 'a.txt')).rejects.toThrow(
			/401/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('names the URL it failed on', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('', 400)));
		await expect(client().readFile('versatiles-org', unlisted('x'), 'a.txt')).rejects.toThrow(
			/raw\.githubusercontent\.com/,
		);
	});
});

describe('graphql', () => {
	it('posts the query and variables, with the token, and returns the data', async () => {
		const fetchMock = vi.fn().mockResolvedValue(reply({ data: { viewer: 'me' } }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await client().graphql('query { viewer }', { a: 1 })).toEqual({ viewer: 'me' });

		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ method: string; body: string; headers: Record<string, string> },
		];
		expect(url).toBe('https://api.github.com/graphql');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ query: 'query { viewer }', variables: { a: 1 } });
		expect(init.headers.authorization).toBe('Bearer test-token');
	});

	it('treats a partial answer as a failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(reply({ data: { a: null }, errors: [{ message: 'Not allowed' }] })),
		);
		await expect(client().graphql('query')).rejects.toThrow('GraphQL: Not allowed');
	});

	it('treats an answer without data as a failure', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({})));
		await expect(client().graphql('query')).rejects.toThrow('no data');
	});
});

describe('latestRelease', () => {
	it('returns the tag, the date and the notes', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				reply({
					tag_name: 'v1.2.3',
					published_at: '2026-11-01T00:00:00Z',
					body: '## Components',
				}),
			),
		);
		expect(await client().latestRelease('versatiles-org', 'x')).toEqual({
			tag: 'v1.2.3',
			date: '2026-11-01T00:00:00Z',
			notes: '## Components',
		});
	});

	it('copes with a release without notes, and a repository without releases', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ tag_name: 'v1', body: null })));
		expect((await client().latestRelease('versatiles-org', 'x'))?.notes).toBe('');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('', 404)));
		expect(await client().latestRelease('versatiles-org', 'x')).toBeNull();
	});
});

describe('getRegistryJson', () => {
	it('parses the document and never sends the GitHub token to a registry', async () => {
		const fetchMock = vi.fn().mockResolvedValue(reply({ 'dist-tags': { latest: '1.0.0' } }));
		vi.stubGlobal('fetch', fetchMock);
		const body = await client().getRegistryJson('https://registry.npmjs.org/x');
		expect(body).toEqual({ 'dist-tags': { latest: '1.0.0' } });
		const headers = (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1]
			.headers;
		expect(headers.authorization).toBeUndefined();
		expect(headers['user-agent']).toBeTruthy();
	});

	it('returns null for a package the registry does not know', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('', 404)));
		expect(await client().getRegistryJson('https://crates.io/api/v1/crates/x')).toBeNull();
	});
});
