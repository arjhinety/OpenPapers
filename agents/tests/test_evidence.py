from openpapers_agents.evidence import Evidence, Ledger, SourceStore, source_key

URL = "https://arxiv.org/html/2305.18290v3"
TEXT = "We find that DPO with β = 0.1 matches or exceeds PPO-based RLHF on summarization  and dialogue."


def make():
    store = SourceStore()
    store.add(URL, TEXT, title="Direct Preference Optimization")
    return store, Ledger(store)


def test_source_key_ignores_version_fragment_scheme():
    assert source_key("https://arxiv.org/html/2305.18290v3#S4") == source_key("http://www.arxiv.org/html/2305.18290/")


def test_records_verbatim_quote_modulo_whitespace_and_case():
    _, ledger = make()
    item = ledger.record("https://arxiv.org/html/2305.18290", "matches or exceeds PPO-based RLHF on summarization and DIALOGUE", "DPO >= PPO", "6.2", "t")
    assert isinstance(item, Evidence)
    assert item.id == "E1" and item.title == "Direct Preference Optimization"


def test_rejects_paraphrase_unknown_source_and_short_quotes():
    _, ledger = make()
    assert ledger.record(URL, "DPO beats PPO on summarization and dialogue", "c", "", "t").startswith("REJECTED_QUOTE_NOT_FOUND")
    assert ledger.record("https://arxiv.org/html/9999.99999", "matches or exceeds PPO-based", "c", "", "t").startswith("REJECTED_UNKNOWN_SOURCE")
    assert ledger.record(URL, "DPO", "c", "", "t").startswith("REJECTED_QUOTE_TOO_SHORT")
    assert len(ledger.rejections) == 3 and not ledger.items


def test_duplicate_quote_returns_existing_id():
    _, ledger = make()
    first = ledger.record(URL, "matches or exceeds PPO-based RLHF", "c", "", "a")
    second = ledger.record(URL, "“matches or exceeds  PPO-based RLHF”", "c2", "", "b")
    assert first.id == second.id and len(ledger.items) == 1


# arXiv HTML renders each formula twice: Unicode, then LaTeX alttext (plus invisible ​ / ⁡)
MATH_SOURCE = (
    "where β " + r"\beta" + " is a parameter controlling the deviation from the base reference policy "
    "π ref " + r"\pi_{\text{ref}}" + ", namely the initial SFT model π SFT " + r"\pi^{\text{SFT}}" + ". "
    "DPO is able to bypass both fitting an explicit reward and performing RL to learn the policy r ∗ ​ ( x, y )"
)


def test_math_reformatting_and_grammatical_insertions_pass():
    store = SourceStore()
    store.add(URL, MATH_SOURCE)
    # writer kept only the LaTeX rendering and wrapped it in \( \)
    assert store.contains(URL, r"a parameter controlling the deviation from the base reference policy \(\pi_{\text{ref}}\), namely the initial SFT model \(\pi^{\text{SFT}}\)")
    assert store.contains(URL, "is able to bypass both fitting an explicit reward and performing RL,")  # trailing punctuation
    assert store.contains(URL, "DPO [is] able to bypass both fitting an explicit reward")


def test_meaning_changing_edits_still_fail():
    store = SourceStore()
    store.add(URL, MATH_SOURCE)
    assert not store.contains(URL, "DPO is [not] able to bypass both fitting an explicit reward")
    assert not store.contains(URL, "DPO is able to bypass ... performing RL to learn the policy")
    assert not store.contains(URL, r"\(\pi_{\text{ref}}\) is the reward model")  # math plus unsupported prose
    # math that swallows most of the quote leaves too little verbatim prose (coverage < 0.6)
    assert not store.contains(URL, r"the base reference \(\pi_{\text{reference policy model distribution}}\)")
