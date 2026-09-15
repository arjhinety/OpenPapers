from openpapers_agents.grounding import reconcile, resolve_checkers, score_pairs, vote


def test_vote_counts_checkers_at_or_above_threshold():
    ballot = vote({"a": 0.5, "b": 0.49}, threshold=0.5)
    assert (ballot.supported_votes, ballot.total, ballot.all_reject) == (1, 2, False)
    assert vote({"a": 0.1, "b": 0.2}).all_reject
    assert not vote({}).all_reject  # no checkers means no veto


def test_reconcile_only_downgrades_llm_supported():
    rejected = vote({"lettucedetect": 0.12, "minicheck": 0.3})
    verdict, note = reconcile("supported", rejected)
    assert verdict == "partial" and "lettucedetect=0.12" in note
    # checkers never upgrade a verdict, and one supporting checker blocks the downgrade
    assert reconcile("unsupported", vote({"a": 0.99})) == ("unsupported", None)
    assert reconcile("supported", vote({"a": 0.1, "b": 0.8})) == ("supported", None)


def test_resolve_checkers_off_and_unknown():
    assert resolve_checkers("off") == ([], [])
    assert resolve_checkers("nonsense") == ([], ["nonsense: unknown checker"])


def test_score_pairs_isolates_a_failing_checker():
    class Good:
        name = "good"

        def support(self, pairs, question):
            return [0.9 for _ in pairs]

    class Broken:
        name = "broken"

        def support(self, pairs, question):
            raise RuntimeError("out of memory")

    errors = []
    out = score_pairs([Broken(), Good()], [("ctx", "claim")], "q", lambda name, exc: errors.append((name, str(exc))))
    assert out == {"good": [0.9]} and errors == [("broken", "out of memory")]


def test_plain_normalizes_double_rendered_math_on_both_sides():
    from openpapers_agents.grounding import plain

    source = "policy \u03c0 ref " + r"\pi_{\text{ref}}" + ", namely the initial SFT model \u03c0 SFT " + r"\pi^{\text{SFT}}" + " with \u03b2 " + r"\beta"
    assert plain(source) == "policy pi ref, namely the initial SFT model pi SFT with beta"
    # a writer's LaTeX-only rendering of the same sentence lands on the same words
    assert plain(r"policy \(\pi_{\text{ref}}\), namely the initial SFT model \(\pi^{\text{SFT}}\) with \(\beta\)") == plain(source)


def test_meta_sections_are_not_grounded():
    from openpapers_agents.gates import section_of_sentences
    from openpapers_agents.grounding import is_meta

    sections = section_of_sentences("# T\n\nA claim here [E1].\n\n## Limitations and open questions\n\nThe paper does not report X [E2].")
    assert [is_meta(sections[s]) for s in ("A claim here [E1].", "The paper does not report X [E2].")] == [False, True]


def test_default_threshold_is_the_calibrated_one():
    from openpapers_agents.grounding import DEFAULT_THRESHOLD

    assert DEFAULT_THRESHOLD == 0.45
    assert vote({"lettucedetect": 0.46}).supported_votes == 1  # would have been a veto at 0.5
