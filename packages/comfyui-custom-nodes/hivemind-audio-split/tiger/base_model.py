# The base class TIGER's two models inherit from, reduced to what inference
# uses. Upstream's look2hear/models/base_model.py also mixes in
# huggingface_hub.PyTorchModelHubMixin and imports pytorch_lightning to
# serialize checkpoints; this pack loads pinned, checksummed weights itself
# (see ../weights.py), so neither dependency is needed.
import torch.nn as nn


class BaseModel(nn.Module):
    def __init__(self, sample_rate, in_chan=1):
        super().__init__()
        self._sample_rate = sample_rate
        self._in_chan = in_chan

    def forward(self, *args, **kwargs):
        raise NotImplementedError
