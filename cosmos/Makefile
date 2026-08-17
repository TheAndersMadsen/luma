.PHONY: check rust-check python-test render render-production hygiene

export PYTHONDONTWRITEBYTECODE := 1

check: rust-check python-test hygiene

rust-check:
	cargo fmt --all -- --check
	cargo test --workspace --locked
	cargo check --workspace --all-targets --locked
	cargo clippy --workspace --all-targets --locked -- -D warnings

python-test:
	python3 -m unittest discover -s verify -p 'test_*.py' -v
	python3 prompts/registry_tool.py validate

render:
	cd .. && ./revival doctor

# Production requires protected env files and deliberately has no sample-secret
# fallback. The root Ai Pin Revival deployer supplies those inputs.
render-production:
	cd .. && ./revival deploy production --dry-run

hygiene:
	python3 verify/hygiene.py
