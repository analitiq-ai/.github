"""`schema-bump`: decide, verify and evaluate schema version bumps.

    schema-bump decide --resource R --from-version V --old OLD.json --new NEW.json [--bump B --reason TEXT]
        Print the bump record publishing NEW over OLD. Calls the models; needs
        OPENROUTER_API_KEY. Exit 3 when nothing changed, 2 on any failure.
    schema-bump verify --record REC.json --resource R --from-version V --to-version W --old OLD.json --new NEW.json
        Exit 0 when the record justifies publishing NEW as W over OLD at V,
        1 when it does not. Offline.
    schema-bump eval [--history DIR [--labels FILE]] [--runs N] [--workers N] [--out FILE]
        Run the evaluation. Paid; needs OPENROUTER_API_KEY. Exit 1 when the
        acceptance bars fail, 2 on any other failure.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import cascade, evaluation
from .inputs import read_json_object
from .record import NoChange, decide_record, record_problem
from .semver import BUMPS, parse_semver


def _positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, got {value}")
    return value


def _semver(text: str) -> str:
    try:
        parse_semver(text)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error
    return text


def _directory(text: str) -> Path:
    path = Path(text)
    if not path.is_dir():
        raise argparse.ArgumentTypeError(f"{text}: not a directory")
    return path


def _file(text: str) -> Path:
    path = Path(text)
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"{text}: not a file")
    return path


def _output_file(text: str) -> Path:
    path = Path(text)
    if not path.parent.is_dir():
        raise argparse.ArgumentTypeError(f"{text}: {path.parent} is not a directory")
    return path


def _json_object(text: str) -> dict:
    try:
        return read_json_object(Path(text))
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _api_key() -> str | None:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("OPENROUTER_API_KEY is not set.", file=sys.stderr)
    return key


def _decide(args: argparse.Namespace) -> int:
    override = None
    if args.bump is not None or args.reason is not None:
        override = {"bump": args.bump, "reason": args.reason}
        if problem := cascade.override_problem(override):
            print(f"{args.resource}: {problem}", file=sys.stderr)
            return 2
    api_key = _api_key()
    if not api_key:
        return 2
    try:
        record, cost = decide_record(
            args.resource, args.from_version, args.old, args.new, cascade.openrouter_post(api_key), override
        )
    except NoChange as error:
        print(error, file=sys.stderr)
        return 3
    except cascade.BumpClassificationError as error:
        print(f"{args.resource}: the change could not be classified: {error}", file=sys.stderr)
        return 2
    print(f"{args.resource}: {record['from']} → {record['to']} ({record['final']}, cost ${cost:.4f})", file=sys.stderr)
    print(json.dumps(record, indent=2, sort_keys=True))
    return 0


def _verify(args: argparse.Namespace) -> int:
    problem = record_problem(args.record, args.resource, args.from_version, args.to_version, args.old, args.new)
    if problem:
        print(f"{args.resource}: the bump record {problem}", file=sys.stderr)
        return 1
    print(f"{args.resource}: {args.from_version} → {args.to_version} matches its bump record.")
    return 0


def _eval(args: argparse.Namespace) -> int:
    api_key = _api_key()
    if not api_key:
        return 2
    cases = evaluation.synthetic_cases()
    try:
        if args.history is not None:
            cases = evaluation.historical_cases(args.history, args.labels) + cases
        ok, results = evaluation.run(cases, cascade.openrouter_post(api_key), args.runs, args.workers)
    except (ValueError, cascade.BumpClassificationError) as error:
        print(f"the evaluation stopped: {error}", file=sys.stderr)
        return 2
    if args.out:
        try:
            args.out.write_text(json.dumps(results, indent=2) + "\n")
        except OSError as error:
            print(f"the results could not be written: {error}", file=sys.stderr)
            return 2
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="schema-bump", description=__doc__.strip().splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    decide = sub.add_parser("decide", help="classify a change and print its bump record")
    decide.add_argument("--resource", required=True)
    decide.add_argument("--from-version", required=True, type=_semver)
    decide.add_argument("--old", required=True, type=_json_object)
    decide.add_argument("--new", required=True, type=_json_object)
    decide.add_argument("--bump", choices=BUMPS, help="override the models, in either direction; needs --reason")
    decide.add_argument("--reason", help="why --bump overrides the models; stored in the record")
    decide.set_defaults(func=_decide)

    verify = sub.add_parser("verify", help="check a bump record against the schemas it publishes")
    verify.add_argument("--record", required=True, type=_json_object)
    verify.add_argument("--resource", required=True)
    verify.add_argument("--from-version", required=True, type=_semver)
    verify.add_argument("--to-version", required=True, type=_semver)
    verify.add_argument("--old", required=True, type=_json_object)
    verify.add_argument("--new", required=True, type=_json_object)
    verify.set_defaults(func=_verify)

    run = sub.add_parser("eval", help="measure the cascade against the labelled corpora (paid)")
    run.add_argument("--history", type=_directory, help="a tree of <resource>/X.Y.Z.json pinned versions")
    run.add_argument("--labels", type=_file, help="labels overriding the published bump of historical pairs")
    run.add_argument("--runs", type=_positive_int, default=3)
    run.add_argument("--workers", type=_positive_int, default=8)
    run.add_argument("--out", type=_output_file, help="write every scored result as JSON here")
    run.set_defaults(func=_eval)

    args = parser.parse_args(argv)
    if args.command == "eval" and args.labels is not None and args.history is None:
        parser.error("--labels needs --history")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
