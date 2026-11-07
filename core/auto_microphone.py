"""Find an openable recording endpoint, never a speaker-only endpoint."""


def input_candidates(devices, default_index=-1, preferred_name=''):
    candidates = [(i, d) for i, d in enumerate(devices)
                  if d.get('max_input_channels', 0) > 0]
    def priority(item):
        i, d = item
        name = d.get('name', '').casefold()
        preferred = preferred_name and name == preferred_name.casefold()
        headset = any(word in name for word in ('headset', 'headphone', 'fone', 'hands-free'))
        webcam = any(word in name for word in ('webcam', 'web cam', 'camera', 'câmera'))
        return (not preferred, i != default_index, not headset, not webcam, i)
    return sorted(candidates, key=priority)


def open_available_input(sd, factory, preferred_name=''):
    devices = list(sd.query_devices())
    try:
        default = int(sd.default.device[0])
    except (TypeError, ValueError, IndexError):
        default = -1
    failures = []
    for index, device in input_candidates(devices, default, preferred_name):
        stream = None
        try:
            stream = factory(index)
            stream.start()
            return stream, index, device.get('name', str(index))
        except Exception as exc:
            failures.append(str(exc))
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass
    raise RuntimeError('Nenhum microfone disponível para gravação. '
                       + (failures[-1] if failures else 'Conecte um headset, webcam ou monitor com microfone.'))
