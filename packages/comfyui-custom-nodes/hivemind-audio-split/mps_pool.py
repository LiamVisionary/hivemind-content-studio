"""adaptive_avg_pool1d that also runs on an Apple GPU.

MPS implements adaptive average pooling only where the input length is a whole
multiple of the output length, and raises otherwise. TIGER pools its band axis
(61 or 67 bands) down a pyramid of sizes that never divide evenly, so on a Mac
the model either ran on CPU - measured at over thirteen CPU-minutes for three
seconds of audio - or not at all.

This is the same arithmetic the op is defined by: output i is the mean of
input[floor(i*L/n) : ceil((i+1)*L/n)]. It is computed from one cumulative sum,
so it is exact rather than an approximation and costs two gathers. Everywhere
the native op works it is used unchanged.
"""

import torch
import torch.nn.functional as F


def adaptive_avg_pool1d(x, output_size):
    n = int(output_size[0] if isinstance(output_size, (tuple, list)) else output_size)
    length = x.shape[-1]
    if x.device.type != "mps" or length % n == 0:
        return F.adaptive_avg_pool1d(x, n)
    index = torch.arange(n, device=x.device)
    start = (index * length) // n
    end = -((-(index + 1) * length) // n)
    total = F.pad(x.cumsum(-1), (1, 0))
    return (total.index_select(-1, end) - total.index_select(-1, start)) / (end - start).to(x.dtype)
