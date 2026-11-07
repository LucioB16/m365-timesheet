/**
 * Dataverse CRM lookup: which cases am I working on?
 *
 * Follows the support-case-investigator rule that no interactive Azure login is
 * ever launched from a script. We only ever call `az account show` and
 * `az account get-access-token`; if there is no usable token the collector
 * degrades to "no CRM evidence" and tells the caller exactly what to run.
 */

const { execFileSync } = require('child_process');

const AZ = process.platform === 'win32' ? 'az.cmd' : 'az';

function runAz(args, azureConfigDir) {
    const env = { ...process.env };
    if (azureConfigDir) env.AZURE_CONFIG_DIR = azureConfigDir;
    // On Windows `az` is a .cmd shim: invoke it through cmd.exe explicitly rather
    // than via { shell: true }, which Node flags as an escaping hazard.
    const file = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : AZ;
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', AZ, ...args] : args;
    return execFileSync(file, argv, {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
        windowsVerbatimArguments: false
    }).trim();
}

function origin(url) {
    return String(url || '').replace(/\/+$/, '').replace(/(https?:\/\/[^/]+).*/, '$1');
}

function getToken(config) {
    const resource = origin(config.CRM_URL);
    if (!resource) throw new Error('CRM_URL is not configured.');
    // A guest identity only resolves inside its host tenant: without --tenant the
    // CLI issues a token for the user's home tenant, which Dataverse rejects with
    // "The user is not a member of the organization."
    const args = ['account', 'get-access-token', '--resource', resource];
    if (config.CRM_TENANT_ID) args.push('--tenant', config.CRM_TENANT_ID);
    args.push('--query', 'accessToken', '-o', 'tsv');
    const token = runAz(args, config.CRM_AZURE_CONFIG_DIR);
    if (!token) throw new Error('az returned an empty access token.');
    return token;
}

async function webApi(config, token, urlPath) {
    const url = `${origin(config.CRM_URL)}/api/data/v9.2/${urlPath}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"'
        }
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`${res.status} ${res.statusText} on ${urlPath}${body ? ` :: ${body.slice(0, 300)}` : ''}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

const INCIDENT_ATTRS = `
    <attribute name="incidentid"/><attribute name="ticketnumber"/><attribute name="title"/>
    <attribute name="createdon"/><attribute name="modifiedon"/><attribute name="statuscode"/>
    <attribute name="customerid"/><attribute name="ownerid"/>
    <order attribute="modifiedon" descending="true"/>`;

/**
 * "Cases I'm working on" is deliberately built from several narrow queries rather
 * than one clever filter. A consultant bills plenty of cases that are not
 * assigned to them, so ownership alone is not enough: notes written and
 * activities logged inside the range count as working on a case too.
 */
function myCaseQueries(userId, range) {
    const from = `${range.start}T00:00:00Z`;
    const to = `${range.end}T23:59:59Z`;
    const wrap = (inner) => `<fetch top="250"><entity name="incident">${INCIDENT_ATTRS}${inner}</entity></fetch>`.replace(/\s+/g, ' ');

    return [
        {
            label: 'owned by me and still open',
            xml: wrap(`<filter type="and">
                <condition attribute="ownerid" operator="eq" value="${userId}"/>
                <condition attribute="statecode" operator="eq" value="0"/>
            </filter>`)
        },
        {
            label: 'owned by me and touched in range',
            xml: wrap(`<filter type="and">
                <condition attribute="ownerid" operator="eq" value="${userId}"/>
                <condition attribute="modifiedon" operator="on-or-after" value="${from}"/>
                <condition attribute="modifiedon" operator="on-or-before" value="${to}"/>
            </filter>`)
        },
        {
            label: 'last modified by me in range',
            xml: wrap(`<filter type="and">
                <condition attribute="modifiedby" operator="eq" value="${userId}"/>
                <condition attribute="modifiedon" operator="on-or-after" value="${from}"/>
                <condition attribute="modifiedon" operator="on-or-before" value="${to}"/>
            </filter>`)
        },
        {
            label: 'created by me in range',
            xml: wrap(`<filter type="and">
                <condition attribute="createdby" operator="eq" value="${userId}"/>
                <condition attribute="createdon" operator="on-or-after" value="${from}"/>
                <condition attribute="createdon" operator="on-or-before" value="${to}"/>
            </filter>`)
        },
        {
            label: 'I wrote a note on it in range',
            xml: wrap(`<link-entity name="annotation" from="objectid" to="incidentid" link-type="inner" alias="note">
                <filter type="and">
                    <condition attribute="createdby" operator="eq" value="${userId}"/>
                    <condition attribute="createdon" operator="on-or-after" value="${from}"/>
                    <condition attribute="createdon" operator="on-or-before" value="${to}"/>
                </filter>
            </link-entity>`)
        },
        {
            label: 'I logged an activity on it in range',
            xml: wrap(`<link-entity name="activitypointer" from="regardingobjectid" to="incidentid" link-type="inner" alias="act">
                <filter type="and">
                    <condition attribute="ownerid" operator="eq" value="${userId}"/>
                    <condition attribute="actualend" operator="on-or-after" value="${from}"/>
                    <condition attribute="actualend" operator="on-or-before" value="${to}"/>
                </filter>
            </link-entity>`)
        }
    ];
}

/**
 * A consultant often exists twice in a partner CRM: once as a tenant member and
 * once as a B2B guest. Cases and personal views can hang off either record, and
 * the Azure CLI token only ever authenticates one of them. Resolve every
 * systemuser that plausibly is the same person and query them all.
 */
async function resolveIdentities(config, token, whoami, warnings) {
    const ids = new Map([[whoami.UserId, 'token identity']]);

    for (const extra of config.CRM_EXTRA_USER_IDS || []) ids.set(extra, 'configured CRM_EXTRA_USER_IDS');

    const localParts = [...new Set([config.CRM_USER_EMAIL, config.USER_EMAIL]
        .filter(Boolean)
        .map((e) => String(e).split('@')[0].trim())
        .filter((s) => s.length >= 4))];

    for (const part of localParts) {
        const safe = part.replace(/'/g, "''");
        try {
            const data = await webApi(config, token, `systemusers?$select=fullname,domainname,systemuserid,isdisabled&$filter=contains(domainname,'${encodeURIComponent(safe).replace(/%20/g, ' ')}') and isdisabled eq false`);
            for (const u of data.value || []) {
                if (!ids.has(u.systemuserid)) ids.set(u.systemuserid, `matched "${u.domainname}"`);
            }
        } catch (e) {
            warnings.push(`Could not look up sibling user records for "${part}": ${e.message.split('::')[0].trim()}`);
        }
    }

    return [...ids.entries()].map(([id, why]) => ({ id, why }));
}

function mapIncident(row) {    return {
        caseId: row.ticketnumber || null,
        title: row.title || '',
        client: row['_customerid_value@OData.Community.Display.V1.FormattedValue'] || '',
        owner: row['_ownerid_value@OData.Community.Display.V1.FormattedValue'] || '',
        status: row['statuscode@OData.Community.Display.V1.FormattedValue'] || '',
        modifiedOn: row.modifiedon || '',
        createdOn: row.createdon || '',
        incidentId: row.incidentid || null
    };
}

/**
 * Which Azure CLI profiles to try. A consultant working inside a partner tenant
 * often has one profile per identity, and each identity sees different records,
 * so we query them all and merge rather than betting on one.
 */
function profileDirs(config) {
    const dirs = [];
    for (const d of config.CRM_AZURE_CONFIG_DIRS || []) if (d && !dirs.includes(d)) dirs.push(d);
    if (config.CRM_AZURE_CONFIG_DIR && !dirs.includes(config.CRM_AZURE_CONFIG_DIR)) dirs.push(config.CRM_AZURE_CONFIG_DIR);
    return dirs.length ? dirs : [null];
}

/**
 * A saved view selects whatever columns its author chose, which is rarely what
 * we need. Re-fetch the same records with our own attribute set so every case,
 * whatever its source, carries the same fields.
 */
async function hydrateIncidents(config, token, ids, warnings) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const values = chunk.map((id) => `<value>${id}</value>`).join('');
        const xml = `<fetch top="100"><entity name="incident">${INCIDENT_ATTRS}
            <filter><condition attribute="incidentid" operator="in">${values}</condition></filter>
        </entity></fetch>`.replace(/\s+/g, ' ');
        try {
            const data = await webApi(config, token, `incidents?fetchXml=${encodeURIComponent(xml)}`);
            out.push(...(data.value || []));
        } catch (e) {
            warnings.push(`Could not hydrate ${chunk.length} case(s) from the view: ${e.message.split('::')[0].trim()}`);
        }
    }
    return out;
}

/** Runs the view lookup / fallback queries for one authenticated profile. */
async function collectForProfile(config, range, dir, warnings, state = {}) {
    const scoped = { ...config, CRM_AZURE_CONFIG_DIR: dir };
    // Only the profile's last path segment is used in messages: the full path is
    // a local absolute path, and those are refused inside the Copilot prompt.
    const label = dir ? `profile "${String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop()}"` : 'default az profile';

    let token;
    try {
        token = getToken(scoped);
    } catch (e) {
        const hint = dir ? `AZURE_CONFIG_DIR="${dir}" ` : '';
        warnings.push(`No Dataverse token from ${label} (${e.message.split('\n')[0]}). Run this yourself, then re-run: ${hint}az login --allow-no-subscriptions`);
        return null;
    }

    let whoami;
    try {
        whoami = await webApi(scoped, token, 'WhoAmI');
    } catch (e) {
        warnings.push(`WhoAmI failed for ${label}: ${e.message}`);
        return null;
    }

    let rows = null;
    let source = '';

    // 1. The user's own saved view, when this identity can actually read it. Once
    //    one profile has read it there is nothing to gain from the others, which
    //    would only log the 403 the wrong identity always gets.
    if (config.CRM_VIEW_ID && !state.viewRead) {
        for (const [collection, kind] of [['userqueries', 'personal view'], ['savedqueries', 'system view']]) {
            try {
                const view = await webApi(scoped, token, `${collection}(${config.CRM_VIEW_ID})?$select=name,fetchxml`);
                const data = await webApi(scoped, token, `incidents?fetchXml=${encodeURIComponent(view.fetchxml)}`);
                const ids = (data.value || []).map((r) => r.incidentid).filter(Boolean);
                rows = ids.length ? await hydrateIncidents(scoped, token, ids, warnings) : [];
                for (const row of rows) row.__reasons = [`in your saved view "${view.name}"`];
                source = `${kind} "${view.name}" via ${label}`;
                state.viewRead = true;
                break;
            } catch (e) {
                warnings.push(`${label}: configured view is not readable as a ${kind} (${e.status || '?'}).`);
            }
        }
    }

    const identities = await resolveIdentities(scoped, token, whoami, warnings);

    // 2. Fallback: several narrow queries we control, run for every identity
    //    that is really this person, then merged.
    if (!rows) {
        const merged = new Map();
        const used = [];
        for (const identity of identities) {
            for (const q of myCaseQueries(identity.id, range)) {
                try {
                    const data = await webApi(scoped, token, `incidents?fetchXml=${encodeURIComponent(q.xml)}`);
                    const found = data.value || [];
                    for (const row of found) {
                        if (!merged.has(row.incidentid)) merged.set(row.incidentid, { ...row, __reasons: [] });
                        merged.get(row.incidentid).__reasons.push(q.label);
                    }
                    if (found.length) used.push(`${q.label} (${found.length})`);
                } catch (e) {
                    warnings.push(`${label}: case query "${q.label}" failed: ${e.message.split('::')[0].trim()}`);
                }
            }
        }
        rows = [...merged.values()];
        source = `built-in queries via ${label} over ${identities.length} identity/identities: ${used.join(', ') || 'no matches'}`;
    }

    return { token, whoami, identities, rows, source, scoped };
}

/**
 * @returns {{ok:boolean, source:string, user:object|null, cases:Array, knownIds:string[], warnings:string[]}}
 */
async function collectCrmCases(config, range, options = {}) {
    const warnings = [];
    const empty = { ok: false, source: 'none', user: null, cases: [], knownIds: [], warnings };

    if (!config.CRM_URL) {
        warnings.push('CRM_URL is not configured; skipping the CRM case list.');
        return empty;
    }

    const merged = new Map();
    const sources = [];
    const identityIds = new Set();
    const state = {};
    let primary = null;

    for (const dir of profileDirs(config)) {
        const result = await collectForProfile(config, range, dir, warnings, state);
        if (!result) continue;
        if (!primary) primary = result;
        for (const id of result.identities) identityIds.add(id.id);
        sources.push(result.source);
        for (const row of result.rows) {
            const existing = merged.get(row.incidentid);
            if (existing) {
                existing.__reasons = [...new Set([...(existing.__reasons || []), ...(row.__reasons || [])])];
            } else {
                merged.set(row.incidentid, { ...row, __reasons: row.__reasons || [] });
            }
        }
    }

    if (!primary) return empty;
    if (merged.size === 0) warnings.push('Every case query returned nothing; no CRM evidence is available.');

    let cases = [...merged.values()].map((r) => ({ ...mapIncident(r), reasons: r.__reasons || [] })).filter((c) => c.caseId);
    cases.sort((a, b) => String(b.modifiedOn).localeCompare(String(a.modifiedOn)));

    // Portal comments and audit history are what actually date the work, so they
    // are collected unless the caller explicitly opts out.
    let detail = null;
    if (options.detail !== false && cases.length) {
        const { enrichCases } = require('./crm_case_detail');
        detail = await enrichCases(primary.scoped, primary.token, cases, range, {
            timezone: options.timezone || config.TIMEZONE,
            identityIds: [...identityIds]
        });
        cases = detail.cases;
        warnings.push(...detail.warnings);
    }

    return {
        ok: true,
        source: sources.join(' | '),
        user: primary.whoami,
        identityIds: [...identityIds],
        cases,
        knownIds: [...new Set(cases.map((c) => c.caseId))].sort(),
        warnings
    };
}

module.exports = { collectCrmCases, getToken, webApi, myCaseQueries, origin, profileDirs };
