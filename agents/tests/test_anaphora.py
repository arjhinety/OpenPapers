from openpapers_agents.gates import previous_sentences
from openpapers_agents.grounding import LettuceDetectChecker, is_anaphoric


def test_previous_sentence_stays_within_section():
    report = (
        "# T\n\nDouble Quantization quantizes the constants [E1]. This compresses the overhead [E2].\n\n"
        "## Next\n\nThis starts a section [E3]."
    )
    prev = previous_sentences(report)
    assert prev["This compresses the overhead [E2]."] == "Double Quantization quantizes the constants [E1]."
    assert prev["This starts a section [E3]."] == ""  # no context carried across headings


def test_is_anaphoric():
    assert is_anaphoric("This compresses the overhead")
    assert is_anaphoric("**They** spill states")
    assert not is_anaphoric("Thistle grows")
    assert not is_anaphoric("Double Quantization compresses")


class FakeDetector:
    """Flags one span at the start of the answer (0.99) and one at its end (0.3)."""

    def predict(self, context, question, answer, output_format):
        return [{"start": 0, "end": 5, "confidence": 0.99}, {"start": len(answer) - 4, "end": len(answer), "confidence": 0.3}]


def test_only_spans_inside_the_claim_count():
    checker = LettuceDetectChecker.__new__(LettuceDetectChecker)
    checker._detector = FakeDetector()
    claim = "This compresses the overhead."
    # with the prefix, the 0.99 span falls inside the prefix and is ignored -> 1 - 0.3
    assert checker.support([("ctx", claim)], "q", ["Double Quantization quantizes the constants."]) == [0.7]
    # without a prefix both spans are in the claim -> 1 - 0.99
    assert checker.support([("ctx", claim)], "q") == [0.01]
