from openpapers_agents.evidence import Ledger, SourceStore
from openpapers_agents.gates import apply_edits, check_report, cited_ids, dedupe_repeats, quotes, render_references, sentences, unquote_unverified
from openpapers_agents.schemas import Edit

URL = "https://arxiv.org/html/2305.18290"


def ledger_with(*quotes):
    store = SourceStore()
    store.add(URL, " ".join(quotes), title="DPO")
    ledger = Ledger(store)
    for quote in quotes:
        ledger.record(URL, quote, "claim", "S1", "t")
    return store, ledger


def test_cited_ids_and_sentence_split():
    assert cited_ids("a [E1, e2] b [E3; E4]") == ["E1", "E2", "E3", "E4"]
    text = "# Title\n\nDPO drops the reward model. [E1] It uses a KL term [E2].\n- Bullet claim [E3]."
    assert sentences(text) == ["DPO drops the reward model. [E1]", "It uses a KL term [E2].", "Bullet claim [E3]."]


def test_apply_edits_is_surgical():
    text = "Alpha sentence. Beta sentence. Beta sentence."
    result = apply_edits(
        text,
        [
            Edit(find="Alpha sentence.", replace="Alpha fixed [E1]."),
            Edit(find="Beta sentence.", replace="x"),  # ambiguous
            Edit(find="Missing.", replace="x"),
            Edit(find="Alpha fixed", replace="y [E9]"),  # unknown evidence
        ],
        known_ids={"E1"},
    )
    assert result.text == "Alpha fixed [E1]. Beta sentence. Beta sentence."
    assert len(result.applied) == 1
    assert [r["rejection"].split(" ")[0] for r in result.rejected] == ["find", "find", "replacement"]


def test_check_report_flags_unknown_ids_fabricated_quotes_and_numbers():
    store, ledger = ledger_with("DPO uses beta 0.1 for summarization experiments", "the policy is trained without an explicit reward model")
    report = (
        "# R\n\nDPO trains without an explicit reward model [E2]. It used beta 0.1 in 2023 [E1]. "
        "It reached 61% win rate [E1]. A claim with a ghost citation here [E7]. "
        'The paper says "DPO is strictly better than every RL method" [E1]. '
        "This long sentence has no citation at all and should be counted."
    )
    gate = check_report(report, ledger, store)
    assert gate.unknown_ids == ["E7"]
    assert gate.quote_violations == ["DPO is strictly better than every RL method"]
    assert [n["number"] for n in gate.untraceable_numbers] == ["61"]  # 0.1 is in the quote, 2023 is a year
    assert gate.uncited_sentences == 1
    assert gate.hard_failures == 2


def test_short_quote_does_not_create_phantom_quote():
    # regression (eval DPO run): the closing mark of "reward" used to open a phantom quote
    # spanning two sentences of prose up to the next real quote
    store, ledger = ledger_with("the policy is trained without an explicit reward model")
    report = (
        '# R\n\nThe "reward" inside this loss is implicit and defined by the language model and the reference model [E1]. '
        'Examples are weighted by how incorrectly the implicit model orders them, so "the policy is trained without an explicit reward model" [E1].'
    )
    assert quotes(report)[0][2] == "the policy is trained without an explicit reward model"
    assert len(quotes(report)) == 1  # "reward" is terminology, not a citation
    assert check_report(report, ledger, store).quote_violations == []
    assert unquote_unverified(report, store) == (report, [])


def test_quoted_spans_pair_curly_and_ignore_unpaired():
    text = 'A “long curly quoted span goes here” then an unpaired " mark.\n\nNew "paragraph quote is long enough" end.'
    assert [inner for _, _, inner in quotes(text)] == ["long curly quoted span goes here", "paragraph quote is long enough"]


def test_dedupe_repeats_drops_echoed_anchor():
    line = "- LoRA keeps the base model fixed [E9]. LoRA keeps the base model fixed [E9]; QLoRA adds NF4 [E1]. Other [E2]."
    fixed, removed = dedupe_repeats(line)
    assert fixed == "- LoRA keeps the base model fixed [E9]; QLoRA adds NF4 [E1]. Other [E2]."
    assert removed == 1
    assert dedupe_repeats("Short. Short. Fine.")[1] == 0  # tiny fragments are left alone


def test_unquote_unverified_keeps_real_quotes():
    store, _ = ledger_with("the policy is trained without an explicit reward model")
    report = 'A: "the policy is trained without an explicit reward model" [E1]. B: "DPO fit[s] an implicit reward in closed form" [E1].\n\n## References\n- "untouched reference quote text"'
    fixed, unquoted = unquote_unverified(report, store)
    assert unquoted == ["DPO fit[s] an implicit reward in closed form"]
    assert '"the policy is trained without an explicit reward model"' in fixed
    assert 'B: DPO fit[s] an implicit reward in closed form [E1].' in fixed
    assert '"untouched reference quote text"' in fixed


def test_render_references_lists_cited_evidence_in_order():
    _, ledger = ledger_with("the policy is trained without an explicit reward model", "DPO uses beta 0.1 for summarization experiments")
    out = render_references("# R\n\nB [E2]. A [E1].\n\n## References\nstale", ledger)
    refs = out.split("## References", 1)[1]
    assert "stale" not in refs
    assert refs.index("[E2]") < refs.index("[E1]")
