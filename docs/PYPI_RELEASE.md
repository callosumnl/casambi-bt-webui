# PyPI Release Guide

The repository is prepared as a **PEP 517 source and wheel distribution** named `casambi-bt-webui`, versioned in `pyproject.toml`. The package intentionally distributes a Raspberry Pi deployment companion rather than pretending that a Python wheel can install and operate the React/Node.js application by itself. The companion provides preflight diagnostics and safe access to non-secret systemd/environment templates; install the full Node.js application from this repository as documented in the root README.

> Before first publication, confirm that the intended project name and licensing statement are appropriate for your organization. The current metadata uses a proprietary-license declaration to avoid granting an unapproved open-source license.

## Local release validation

Create an isolated environment for release tools and validate both the source distribution and wheel. The validation script checks package metadata with Twine, installs the wheel into a temporary target directory, and exercises the console entry point without requiring a Bluetooth device.

```bash
python3 -m venv .release-venv
. .release-venv/bin/activate
python -m pip install --upgrade pip build twine
./scripts/validate-package.sh
```

The resulting `build/python-dist/` directory (kept apart from the web app's `dist/`) is ignored by Git and must be regenerated for each release. Inspect the output with `python -m twine check dist/*` before publishing.

## TestPyPI and PyPI publication

Publish to TestPyPI first to verify public installation metadata, then create a clean virtual environment and install the exact released version. Prefer PyPI Trusted Publishing with an OIDC-based GitHub Actions environment rather than a long-lived API token. Do not upload a build that has not passed the local validation above.

```bash
# TestPyPI dry-run publication, after configuring a TestPyPI trusted publisher or token.
python -m twine upload --repository testpypi build/python-dist/*

# Validate the released TestPyPI wheel in a clean environment.
python -m pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ casambi-bt-webui==0.1.0
casambi-bt-webui doctor

# Publish the same validated artifacts to production PyPI only after approval.
python -m twine upload build/python-dist/*
```

## Version and release checklist

| Step | Required action |
| --- | --- |
| Version | Increment `project.version` and `src/casambi_bt_webui/__init__.py` together. |
| Compatibility | Keep `requires-python` aligned with the supported Raspberry Pi Python runtime. |
| Metadata | Review package name, project URLs, summary, licensing, and README content. |
| Validation | Run `pnpm check`, `pnpm test`, `pnpm build`, and `./scripts/validate-package.sh`. |
| Security | Never package `.env`, SQLite data, private keys, access tokens, or real Casambi credentials. |
| Publication | Use TestPyPI first, then upload the exact validated artifacts to PyPI. |
