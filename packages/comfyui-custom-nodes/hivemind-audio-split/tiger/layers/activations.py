# Vendored from TIGER (https://github.com/JusperLee/TIGER, MIT, (c) Kai Li),
# by way of billwuhao/ComfyUI_AudioTools @ 41463715b476aa1d44de617119a68d8841aa04bd
# (Apache-2.0), file look2hear/layers/activations.py.
#
# Changed here, and only this:
#   * construction-time debug prints removed;
#   * `.type(input.type())` replaced with `.to(dtype=...)` - the legacy type
#     string for an Apple-GPU tensor ("torch.mps.FloatTensor") is one
#     Tensor.type() refuses, so the model could not run on MPS at all;
#   * F.adaptive_avg_pool1d routed through ..mps_pool, because MPS implements
#     it only where the input length divides evenly and these band counts do not.
# See ../NOTICE.md for the licences.
import torch
from torch import nn


def linear():
    return nn.Identity()


def relu():
    return nn.ReLU()


def prelu():
    return nn.PReLU()


def leaky_relu():
    return nn.LeakyReLU()


def sigmoid():
    return nn.Sigmoid()


def softmax(dim=None):
    return nn.Softmax(dim=dim)


def tanh():
    return nn.Tanh()


def gelu():
    return nn.GELU()


def register_activation(custom_act):
    if (
        custom_act.__name__ in globals().keys()
        or custom_act.__name__.lower() in globals().keys()
    ):
        raise ValueError(
            f"Activation {custom_act.__name__} already exists. Choose another name."
        )
    globals().update({custom_act.__name__: custom_act})


def get(identifier):
    if identifier is None:
        return None
    elif callable(identifier):
        return identifier
    elif isinstance(identifier, str):
        cls = globals().get(identifier)
        if cls is None:
            raise ValueError(
                "Could not interpret activation identifier: " + str(identifier)
            )
        return cls
    else:
        raise ValueError(
            "Could not interpret activation identifier: " + str(identifier)
        )


